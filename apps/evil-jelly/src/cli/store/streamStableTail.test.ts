import { describe, expect, it } from "vitest";
import { StreamStableTailController } from "./streamStableTail";

describe("StreamStableTailController", () => {
  it("keeps an unterminated line in the tail until newline arrives", () => {
    const controller = new StreamStableTailController();

    expect(controller.push("hello")).toEqual({ stableText: "", tailText: "hello" });
    expect(controller.push(" world\nnext")).toEqual({
      stableText: "hello world\n",
      tailText: "next",
    });
  });

  it("holds a possible table header until the next structural line arrives", () => {
    const controller = new StreamStableTailController();

    expect(controller.push("alpha | beta\n")).toEqual({
      stableText: "",
      tailText: "alpha | beta\n",
    });
    expect(controller.push("\nplain text\n")).toEqual({
      stableText: "alpha | beta\n\nplain text\n",
      tailText: "",
    });
  });

  it("holds an active confirmed pipe table until it terminates", () => {
    const controller = new StreamStableTailController();

    expect(controller.push("Intro\n")).toEqual({ stableText: "Intro\n", tailText: "" });
    expect(controller.push("| A | B |\n")).toEqual({ stableText: "", tailText: "| A | B |\n" });
    expect(controller.push("| --- | --- |\n")).toEqual({
      stableText: "",
      tailText: "| A | B |\n| --- | --- |\n",
    });
    expect(controller.push("| 1 | 2 |\n\nAfter\n")).toEqual({
      stableText: "| A | B |\n| --- | --- |\n| 1 | 2 |\n\nAfter\n",
      tailText: "",
    });

    expect(controller.finalize("Intro\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nAfter\n")).toEqual({
      visualRemainder: "",
      shouldHideFinal: true,
    });
  });

  it("releases a confirmed pipe table when a non-table line follows it", () => {
    const controller = new StreamStableTailController();

    expect(controller.push("Intro\n| A | B |\n| --- | --- |\n| 1 | 2 |\n")).toEqual({
      stableText: "Intro\n",
      tailText: "| A | B |\n| --- | --- |\n| 1 | 2 |\n",
    });
    expect(controller.push("After\n")).toEqual({
      stableText: "| A | B |\n| --- | --- |\n| 1 | 2 |\nAfter\n",
      tailText: "",
    });
  });

  it("releases a possible table header when a blank line follows it", () => {
    const controller = new StreamStableTailController();

    expect(controller.push("alpha | beta\n")).toEqual({
      stableText: "",
      tailText: "alpha | beta\n",
    });
    expect(controller.push("\n")).toEqual({
      stableText: "alpha | beta\n\n",
      tailText: "",
    });
  });

  it("ignores table-like lines inside non-markdown fences", () => {
    const controller = new StreamStableTailController();

    expect(controller.push("```sh\n| A | B |\n| --- | --- |\n```\n")).toEqual({
      stableText: "```sh\n| A | B |\n| --- | --- |\n```\n",
      tailText: "",
    });
  });

  it("holds an unclosed code fence so markdown stream chunks remain renderable", () => {
    const controller = new StreamStableTailController();

    expect(controller.push("Intro\n```ts\nconst value = 1;\n")).toEqual({
      stableText: "Intro\n",
      tailText: "```ts\nconst value = 1;\n",
    });
    expect(controller.push("```\nAfter\n")).toEqual({
      stableText: "```ts\nconst value = 1;\n```\nAfter\n",
      tailText: "",
    });
  });

  it("holds an unclosed blockquoted code fence", () => {
    const controller = new StreamStableTailController();

    expect(controller.push("Lead\n> ```sh\n> echo hi\n")).toEqual({
      stableText: "Lead\n",
      tailText: "> ```sh\n> echo hi\n",
    });
  });

  it("detects blockquoted and no-outer-pipe tables", () => {
    const quoted = new StreamStableTailController();
    expect(quoted.push("> | A | B |\n> | --- | --- |\n")).toEqual({
      stableText: "",
      tailText: "> | A | B |\n> | --- | --- |\n",
    });

    const noOuter = new StreamStableTailController();
    expect(noOuter.push("A | B\n--- | ---\n")).toEqual({
      stableText: "",
      tailText: "A | B\n--- | ---\n",
    });
  });
});
