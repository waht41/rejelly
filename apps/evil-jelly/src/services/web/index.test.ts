import { describe, expect, it } from "vitest";
import { diagnoseSearchResults } from "./index";
import { parseAnthropicWebSearch } from "./searchProvider";

describe("diagnoseSearchResults", () => {
  it("keeps relevant technical results", () => {
    const diagnostics = diagnoseSearchResults({
      query: "undici npm",
      provider: "llm",
      requestedUrl: "https://api.example.test/anthropic/v1/messages",
      finalUrl: "https://api.example.test/anthropic/v1/messages",
      results: [
        {
          title: "undici - npm",
          url: "https://www.npmjs.com/package/undici",
          snippet: "An HTTP/1.1 client for Node.js.",
        },
        {
          title: "GitHub - nodejs/undici",
          url: "https://github.com/nodejs/undici",
          snippet: "HTTP client written from scratch.",
        },
        {
          title: "Using Undici fetch in Node.js",
          url: "https://nodejs.org/en/learn/getting-started/fetch",
          snippet: "Undici powers fetch in Node.js.",
        },
      ],
    });

    expect(diagnostics.polluted).toBe(false);
    expect(diagnostics.matchedResultCount).toBe(3);
    expect(diagnostics.finalHost).toBe("api.example.test");
  });

  it("flags unrelated results with an ignored site constraint", () => {
    const diagnostics = diagnoseSearchResults({
      query: "site:example-source.test rarewidget",
      provider: "llm",
      requestedUrl: "https://api.example.test/anthropic/v1/messages",
      finalUrl: "https://api.example.test/anthropic/v1/messages",
      results: [
        {
          title: "Generic help center",
          url: "https://help.example.com/articles/intro",
          snippet: "A general introduction page.",
        },
        {
          title: "Dictionary entry for common words",
          url: "https://dictionary.example.net/common",
          snippet: "Common dictionary examples.",
        },
        {
          title: "Product catalog",
          url: "https://shop.example.org/catalog",
          snippet: "A broad product listing.",
        },
      ],
    });

    expect(diagnostics.polluted).toBe(true);
    expect(diagnostics.pollutionReasons).toEqual([
      "no_query_token_overlap",
      "site_constraint_ignored",
    ]);
    expect(diagnostics.siteConstraintMatched).toBe(false);
  });
});

describe("parseAnthropicWebSearch", () => {
  // Shape mirrors a real DeepSeek /anthropic web_search response (probe-verified).
  const response = {
    content: [
      { type: "thinking", thinking: "..." },
      { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "x" } },
      {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_1",
        content: [
          {
            type: "web_search_result",
            url: "https://ast-grep.github.io/guide/rule-config.html",
            title: "Rule Config | ast-grep",
            encrypted_content: "EqgfCioIARgBIiQ...",
            page_age: null,
          },
          {
            type: "web_search_result",
            url: "https://github.com/ast-grep/ast-grep",
            title: "ast-grep/ast-grep",
            encrypted_content: "Eo8BCioIAhgB...",
          },
          // duplicate url — must be de-duped
          {
            type: "web_search_result",
            url: "https://github.com/ast-grep/ast-grep",
            title: "dup",
          },
        ],
      },
      { type: "text", text: "Here are the sources." },
    ],
  };

  it("harvests deduped {title,url} with empty snippet (encrypted body)", () => {
    const results = parseAnthropicWebSearch(response, 10);
    expect(results).toEqual([
      {
        title: "Rule Config | ast-grep",
        url: "https://ast-grep.github.io/guide/rule-config.html",
        snippet: "",
      },
      { title: "ast-grep/ast-grep", url: "https://github.com/ast-grep/ast-grep", snippet: "" },
    ]);
  });

  it("respects the limit", () => {
    expect(parseAnthropicWebSearch(response, 1)).toHaveLength(1);
  });

  it("falls back to url when title is missing", () => {
    const r = parseAnthropicWebSearch(
      {
        content: [
          {
            type: "web_search_tool_result",
            content: [{ type: "web_search_result", url: "https://x.test" }],
          },
        ],
      },
      5,
    );
    expect(r).toEqual([{ title: "https://x.test", url: "https://x.test", snippet: "" }]);
  });

  it("returns [] on an error result block or malformed response", () => {
    expect(
      parseAnthropicWebSearch(
        {
          content: [
            {
              type: "web_search_tool_result",
              content: { type: "web_search_tool_result_error", error_code: "unavailable" },
            },
          ],
        },
        5,
      ),
    ).toEqual([]);
    expect(parseAnthropicWebSearch({}, 5)).toEqual([]);
    expect(parseAnthropicWebSearch(null, 5)).toEqual([]);
  });
});
