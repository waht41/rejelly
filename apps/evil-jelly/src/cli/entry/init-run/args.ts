import type { CAC } from "cac";

export type InitCommandArgs = {
  kind: "init";
  initBaseUrl: string | undefined;
  initModelId: string | undefined;
  initProtocol: string | undefined;
};

function optionalString(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = String(raw).trim();
  return value.length > 0 ? value : undefined;
}

export function registerInitArgs(cli: CAC): void {
  cli
    .command("init", "Setup global config file under ~/.evil-jelly/.env")
    .option(
      "--base-url <url>",
      "OPENAI_BASE_URL to save alongside the key (keeps key and endpoint in the same layer)",
    )
    .option("--model <id>", "OPENAI_MODEL_ID to save")
    .option("--protocol <protocol>", "OPENAI_API_PROTOCOL to save (chat_completions or responses)");
}

export function parseInitArgs(options: Record<string, unknown>): InitCommandArgs {
  return {
    kind: "init",
    initBaseUrl: optionalString(options.baseUrl),
    initModelId: optionalString(options.model),
    initProtocol: optionalString(options.protocol),
  };
}
