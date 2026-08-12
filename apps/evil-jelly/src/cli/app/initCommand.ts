import { createInterface } from "node:readline/promises";
import {
  readEnvValues,
  resolveEnvProfilePath,
  resolveGlobalEnvPath,
  saveEnvValues,
} from "../../shared/configuration/env";
import { collectInitConfig } from "./initConfig";

export async function runInitCommand(options: {
  apiKey: string | undefined;
  baseUrl: string | undefined;
  modelId: string | undefined;
  /** With --env, write the named profile instead of the global file. */
  envFile: string | undefined;
}): Promise<void> {
  const targetPath = options.envFile
    ? resolveEnvProfilePath(options.envFile)
    : resolveGlobalEnvPath();
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const readline = interactive
    ? createInterface({ input: process.stdin, output: process.stdout })
    : undefined;
  const { apiKey, baseUrl, modelId } = await collectInitConfig(
    { apiKey: options.apiKey, baseUrl: options.baseUrl, modelId: options.modelId },
    readEnvValues(targetPath),
    readline ? (question) => readline.question(question) : undefined,
  ).finally(() => readline?.close());
  if (!apiKey) {
    console.error(
      interactive
        ? "OPENAI_API_KEY cannot be empty."
        : "OPENAI_API_KEY is not configured; run `evil init` in a TTY or pass --api-key.",
    );
    process.exit(1);
  }
  const filePath = saveEnvValues(targetPath, {
    OPENAI_API_KEY: apiKey,
    ...(baseUrl ? { OPENAI_BASE_URL: baseUrl } : {}),
    ...(modelId ? { OPENAI_MODEL_ID: modelId } : {}),
  });
  console.log(`Configuration saved to ${filePath}`);
}
