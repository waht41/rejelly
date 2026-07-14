import { createMockModel } from "@rejelly/core/testing";
import { describe, expect, it } from "vitest";
import { createRouterAgent } from "./router-agent";

describe("RouterAgent", () => {
  it("should route to chat specialist when target is chat", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({
      reason: "User wants to chit-chat",
      target: "chat",
    });

    const agent = createRouterAgent(mock.adapter);
    const result = await agent({ userInput: "hello" });

    expect(result).toContain("[Chat Specialist]");
    expect(result).toContain("hello");
    expect(mock.calls.count()).toBe(1);
  });

  it("should route to CLI specialist when target is cli", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({
      reason: "User mentioned a command",
      target: "cli",
    });

    const agent = createRouterAgent(mock.adapter);
    const result = await agent({ userInput: "run ls" });

    expect(result).toContain("[CLI Specialist]");
    expect(result).toContain("run ls");
    expect(mock.calls.count()).toBe(1);
  });

  it("should route to life specialist when target is life", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({
      reason: "User asked about daily tasks",
      target: "life",
    });

    const agent = createRouterAgent(mock.adapter);
    const result = await agent({ userInput: "remind me to cook" });

    expect(result).toContain("[Life Assistant]");
    expect(result).toContain("remind me to cook");
    expect(mock.calls.count()).toBe(1);
  });

  it("should return fallback message when target is other", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({
      reason: "Request does not match any known category",
      target: "other",
    });

    const agent = createRouterAgent(mock.adapter);
    const result = await agent({ userInput: "something unknown" });

    expect(result).toContain("Sorry");
    expect(result).toContain("Request does not match any known category");
    expect(result).toContain("extending the RouterAgent");
    expect(mock.calls.count()).toBe(1);
  });

  it("should pass userInput into prompt context", async () => {
    const mock = createMockModel();
    mock.setDefaultResponse({ reason: "Test", target: "other" });

    const agent = createRouterAgent(mock.adapter);
    await agent({ userInput: "my custom query" });

    const call = mock.calls.all()[0];
    const userMessages = call.messages.filter((m) => m.role === "user");
    expect(userMessages.length).toEqual(1);

    const content = userMessages[0].content;
    const hasQuery =
      Array.isArray(content) &&
      content.some(
        (part) => part.type === "text" && "text" in part && part.text.includes("my custom query"),
      );
    expect(hasQuery).toBe(true);
  });
});
