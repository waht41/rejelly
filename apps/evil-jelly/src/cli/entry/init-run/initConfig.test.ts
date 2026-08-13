import { describe, expect, it } from "vitest";
import { collectInitConfig } from "./initConfig";

describe("collectInitConfig", () => {
  it("keeps an existing key on Enter and prompts for optional endpoint and model", async () => {
    const questions: string[] = [];
    const answers = ["", "https://api.deepseek.com", "deepseek-chat"];

    const values = await collectInitConfig(
      {},
      { OPENAI_API_KEY: "sk-existing" },
      async (question) => {
        questions.push(question);
        return answers.shift() ?? "";
      },
    );

    expect(values).toEqual({
      apiKey: "sk-existing",
      baseUrl: "https://api.deepseek.com",
      modelId: "deepseek-chat",
    });
    expect(questions[0]).toContain("already configured; Enter to keep it");
    expect(questions[1]).toContain("OPENAI_BASE_URL (optional;");
    expect(questions[2]).toContain("OPENAI_MODEL_ID (optional;");
    expect(questions[2]).toContain("Enter to use gpt-5.6-luna");
  });

  it("keeps existing optional values on Enter", async () => {
    const values = await collectInitConfig(
      {},
      {
        OPENAI_API_KEY: "sk-existing",
        OPENAI_BASE_URL: "https://existing.example/v1",
        OPENAI_MODEL_ID: "existing-model",
      },
      async () => "",
    );

    expect(values).toEqual({
      apiKey: "sk-existing",
      baseUrl: "https://existing.example/v1",
      modelId: "existing-model",
    });
  });

  it("uses explicit flags without asking for those values", async () => {
    const questions: string[] = [];
    const values = await collectInitConfig(
      {
        apiKey: "sk-cli",
        baseUrl: "https://cli.example/v1",
        modelId: "cli-model",
      },
      { OPENAI_API_KEY: "sk-existing" },
      async (question) => {
        questions.push(question);
        return "";
      },
    );

    expect(values).toEqual({
      apiKey: "sk-cli",
      baseUrl: "https://cli.example/v1",
      modelId: "cli-model",
    });
    expect(questions).toEqual([]);
  });
});
