import type { DOMElement } from "ink";
import { renderToString } from "ink";
import { createElement, createRef } from "react";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { BufferView } from "./BufferView";
import { projectPromptDocument } from "./document/promptDocument";

describe("BufferView", () => {
  it("renders the label and the exact pre-wrapped rows", () => {
    const text = "ask $review";
    const projection = projectPromptDocument(
      [
        { type: "text", text: "ask " },
        {
          type: "token",
          kind: "skill",
          qualifiedName: "project:review",
        },
      ],
      () => "$review",
    );
    const output = stripAnsi(
      renderToString(
        createElement(BufferView, {
          rowRef: createRef<DOMElement>(),
          label: "❯",
          rows: [{ text, start: 0 }],
          tokenSpans: projection.tokenSpans,
          placeholder: "Message",
          empty: false,
        }),
        { columns: 80 },
      ),
    );

    expect(output).toBe("❯ ask $review");
  });

  it("renders the placeholder for an empty document", () => {
    const output = stripAnsi(
      renderToString(
        createElement(BufferView, {
          rowRef: createRef<DOMElement>(),
          label: "",
          rows: [{ text: "", start: 0 }],
          tokenSpans: [],
          placeholder: "Message",
          empty: true,
        }),
        { columns: 80 },
      ),
    );

    expect(output).toBe("❯ Message");
  });
});
