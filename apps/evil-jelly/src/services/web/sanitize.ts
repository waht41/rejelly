/**
 * Dependency-free HTML → readable-markdown sanitizer for the web research kit.
 *
 * MVP intent (INV-0009 §3.2): give the model clean article text, not raw HTML — strip
 * script/style/nav/boilerplate, keep headings/links/lists/paragraphs/code. This is deliberately a
 * pragmatic regex pass, not a DOM/Readability extraction; the upgrade path (jsdom + @mozilla/readability
 * + turndown) is recorded in the INV and can replace `htmlToMarkdown` behind the same signature.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  trade: "™",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  middot: "·",
  bull: "•",
  deg: "°",
  times: "×",
  divide: "÷",
  laquo: "«",
  raquo: "»",
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

/** Strip all tags and decode entities — for short fields like SERP titles/snippets. */
export function stripTags(html: string): string {
  return stripZeroWidth(decodeEntities(html.replace(/<[^>]*>/g, " ")))
    .replace(/\s+/g, " ")
    .trim();
}

/** Remove invisible formatting characters that otherwise leak out of anchors such as VitePress'. */
function stripZeroWidth(input: string): string {
  return input.replace(/(?:\u200B|\u200C|\u200D|\uFEFF)/g, "");
}

/** Remove whole boilerplate regions (script/style/nav/...) including their content. */
function dropBoilerplate(html: string): string {
  const blocks = [
    "script",
    "style",
    "noscript",
    "template",
    "svg",
    "head",
    "nav",
    "header",
    "footer",
    "aside",
    "form",
    "iframe",
    "button",
  ];
  let out = html;
  for (const tag of blocks) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi"), " ");
  }
  // HTML comments.
  out = out.replace(/<!--[\s\S]*?-->/g, " ");
  return out;
}

/** Best-effort isolate the main article body so menus/sidebars don't dominate. */
function isolateMain(html: string): string {
  const main = html.match(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/i);
  return main ? main[2] : html;
}

/** Drop the visual-only gutter emitted by VitePress/Shiki when line numbers are enabled. */
function dropLineNumberGutters(html: string): string {
  return html.replace(
    /<div\b(?=[^>]*\bclass=["'][^"']*\bline-numbers-wrapper\b[^"']*["'])[^>]*>[\s\S]*?<\/div>/gi,
    " ",
  );
}

function codeLanguage(attributes: string, innerHtml: string, prefix: string): string {
  const sources = [attributes, innerHtml.match(/<code\b([^>]*)>/i)?.[1] ?? "", prefix];
  for (const source of sources) {
    const matches = [...source.matchAll(/\blanguage-([a-z0-9_+-]+)/gi)];
    const language = matches.at(-1)?.[1];
    if (language) {
      return language;
    }
  }
  return "";
}

/** Convert a preformatted block without collapsing its meaningful whitespace. */
function preToMarkdown(attributes: string, innerHtml: string, prefix: string): string {
  const language = codeLanguage(attributes, innerHtml, prefix);
  const code = stripZeroWidth(
    decodeEntities(
      innerHtml
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]*>/g, "")
        .replace(/\r\n?/g, "\n"),
    ),
  ).replace(/^\n+|\n+$/g, "");
  const fence = code.includes("```") ? "````" : "```";
  return `${fence}${language}\n${code}\n${fence}`;
}

interface MarkdownResult {
  title: string;
  markdown: string;
}

export function htmlToMarkdown(html: string): MarkdownResult {
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripTags(titleMatch[1]) : "";

  let body = dropBoilerplate(html);
  body = isolateMain(body);
  body = dropLineNumberGutters(body);

  // Protect preformatted blocks before the generic block/tag passes. Their placeholders survive
  // whitespace normalization and are restored as fenced blocks at the end.
  const preBlocks: string[] = [];
  body = body.replace(
    /<pre\b([^>]*)>([\s\S]*?)<\/pre>/gi,
    (_match: string, attributes: string, innerHtml: string, offset: number, source: string) => {
      const token = `\uE000PRE_BLOCK_${preBlocks.length}\uE001`;
      preBlocks.push(
        preToMarkdown(attributes, innerHtml, source.slice(Math.max(0, offset - 512), offset)),
      );
      return `\n\n${token}\n\n`;
    },
  );

  // Block-level structure → markdown markers (process before generic tag strip).
  body = body
    .replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, (_m, t) => `\n\n# ${stripTags(t)}\n\n`)
    .replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, (_m, t) => `\n\n## ${stripTags(t)}\n\n`)
    .replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, (_m, t) => `\n\n### ${stripTags(t)}\n\n`)
    .replace(/<h[4-6]\b[^>]*>([\s\S]*?)<\/h[4-6]>/gi, (_m, t) => `\n\n#### ${stripTags(t)}\n\n`)
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, t) => `\n- ${stripTags(t)}`)
    .replace(/<(p|div|section|tr)\b[^>]*>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(
      /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_m, href: string, text: string) => {
        const label = stripTags(text);
        if (!label) {
          return "";
        }
        return href.startsWith("http") ? `[${label}](${href})` : label;
      },
    )
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, code) => ` \`${stripTags(code)}\` `);

  const text = stripZeroWidth(decodeEntities(body.replace(/<[^>]*>/g, " ")));

  let markdown = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  for (let index = 0; index < preBlocks.length; index += 1) {
    markdown = markdown.replace(`\uE000PRE_BLOCK_${index}\uE001`, preBlocks[index]);
  }

  return { title, markdown };
}
