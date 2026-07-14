/**
 * Single outbound HTTP chokepoint for the web research kit: proxy-aware fetch with timeout, size cap,
 * a browser UA, and a content-type guard. Both web_search (SERP) and read_webpage go through here, so
 * proxy/UA/limit policy lives in exactly one place.
 *
 * Proxying uses this layer's WEB_* knobs only. When disabled, we still pass an explicit direct
 * undici Agent so @rejelly/env's global EnvHttpProxyAgent cannot accidentally proxy web egress.
 */

import { getContextSignal } from "@rejelly/core";
import { Agent, type Dispatcher, ProxyAgent, fetch as undiciFetch } from "undici";
import { getWebConfig } from "./webConfig";

let cachedDirectAgent: Agent | null = null;
let cachedProxyAgent: ProxyAgent | null = null;
let cachedProxyUrl: string | null = null;

function resolveDispatcher(proxyUrl: string | null): Dispatcher {
  if (!proxyUrl) {
    cachedDirectAgent ??= new Agent();
    return cachedDirectAgent;
  }
  if (cachedProxyAgent && cachedProxyUrl === proxyUrl) {
    return cachedProxyAgent;
  }
  cachedProxyAgent = new ProxyAgent(proxyUrl);
  cachedProxyUrl = proxyUrl;
  return cachedProxyAgent;
}

export interface HttpTextResult {
  /** Final URL after redirects. */
  url: string;
  status: number;
  contentType: string;
  /** Decoded body text, truncated to the configured byte cap. */
  body: string;
  /** True when the body was cut at the byte cap. */
  truncated: boolean;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Merge the agent abort signal (if any) with a per-request timeout. */
function buildSignal(timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("request timed out")), timeoutMs);
  const ctxSignal = getContextSignal();
  const onAbort = () => controller.abort(ctxSignal?.reason ?? new Error("aborted"));
  if (ctxSignal) {
    if (ctxSignal.aborted) {
      onAbort();
    } else {
      ctxSignal.addEventListener("abort", onAbort, { once: true });
    }
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      ctxSignal?.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * GET a URL and return decoded text, bounded by the configured timeout and byte cap. Non-text
 * content (images, pdf, ...) is rejected up front so we never stream a multi-MB binary into context.
 */
export async function fetchText(
  url: string,
  options: { acceptHtmlOnly?: boolean } = {},
): Promise<HttpTextResult> {
  const config = getWebConfig();
  const { signal, dispose } = buildSignal(config.timeoutMs);
  try {
    const response = await undiciFetch(url, {
      method: "GET",
      redirect: "follow",
      signal,
      dispatcher: resolveDispatcher(config.proxyUrl),
      // Full browser header set incl. sec-fetch-* / sec-ch-ua: Bing serves only a JS shell (no
      // server-rendered b_algo results) to requests that look automated; these headers flip it to
      // the real SERP. They're harmless for ordinary page fetches too.
      headers: {
        "User-Agent": config.userAgent,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": config.market ? `${config.market},en;q=0.8` : "en-US,en;q=0.9",
        "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        "sec-fetch-user": "?1",
        "upgrade-insecure-requests": "1",
      },
    });

    const contentType = response.headers.get("content-type") ?? "";
    if (options.acceptHtmlOnly && contentType && !/text\/|xml|json/i.test(contentType)) {
      throw new HttpError(
        `unsupported content-type "${contentType}" (expected text/html)`,
        response.status,
      );
    }

    const reader = response.body?.getReader();
    if (!reader) {
      const body = await response.text();
      return {
        url: response.url || url,
        status: response.status,
        contentType,
        body: body.slice(0, config.maxFetchBytes),
        truncated: body.length > config.maxFetchBytes,
      };
    }

    // Stream with a hard byte cap so a huge page can't blow past maxFetchBytes.
    const chunks: Uint8Array[] = [];
    let received = 0;
    let truncated = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        chunks.push(value);
        received += value.byteLength;
        if (received >= config.maxFetchBytes) {
          truncated = true;
          await reader.cancel().catch(() => {});
          break;
        }
      }
    }
    const body = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8");
    return {
      url: response.url || url,
      status: response.status,
      contentType,
      body,
      truncated,
    };
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpError(`fetch failed for ${url}: ${message}`);
  } finally {
    dispose();
  }
}

/**
 * POST (or other method) a JSON body and parse a JSON response, reusing the same proxy-aware
 * dispatcher + abort/timeout machinery as fetchText. Used by the LLM search provider to call a
 * model's Anthropic-mirror endpoint; that round trip runs the model + a server-side search, so it
 * needs its own (larger) timeout rather than the SERP/fetch default.
 */
export async function fetchJson(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    timeoutMs?: number;
  } = {},
): Promise<{ status: number; json: unknown }> {
  const config = getWebConfig();
  const { signal, dispose } = buildSignal(options.timeoutMs ?? config.timeoutMs);
  try {
    const response = await undiciFetch(url, {
      method: options.method ?? "POST",
      signal,
      dispatcher: resolveDispatcher(config.proxyUrl),
      headers: { "content-type": "application/json", ...options.headers },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    if (response.status >= 400) {
      throw new HttpError(`HTTP ${response.status}: ${text.slice(0, 300)}`, response.status);
    }
    try {
      return { status: response.status, json: JSON.parse(text) };
    } catch {
      throw new HttpError(`non-JSON response from ${url}: ${text.slice(0, 200)}`, response.status);
    }
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpError(`request failed for ${url}: ${message}`);
  } finally {
    dispose();
  }
}
