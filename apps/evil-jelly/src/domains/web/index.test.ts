import { describe, expect, it } from "vitest";
import {
  filterSearchResultsBySite,
  parseAnthropicWebSearch,
  parseResponsesWebSearch,
  parseSearchQuery,
  type SearchResult,
} from "./searchProvider";

describe("search query constraints", () => {
  it("separates site: from the terms sent to the search model", () => {
    expect(parseSearchQuery("site:docs.example.test web search API")).toEqual({
      terms: "web search API",
      siteConstraint: "docs.example.test",
    });
    expect(parseSearchQuery("ordinary query")).toEqual({
      terms: "ordinary query",
      siteConstraint: null,
    });
  });

  it("keeps only the requested host and its subdomains", () => {
    const results: SearchResult[] = [
      { title: "root", url: "https://example.test/a", snippet: "" },
      { title: "docs", url: "https://docs.example.test/b", snippet: "" },
      { title: "lookalike", url: "https://notexample.test/c", snippet: "" },
      { title: "suffix", url: "https://example.test.evil.invalid/d", snippet: "" },
    ];

    expect(
      filterSearchResultsBySite(results, "example.test").map((result) => result.title),
    ).toEqual(["root", "docs"]);
  });
});

describe("parseResponsesWebSearch", () => {
  const response = {
    output: [
      {
        type: "web_search_call",
        action: {
          type: "search",
          sources: [
            { type: "url", url: "https://docs.example.test/guide#overview" },
            { type: "url", url: "https://example.test/later" },
            { type: "url", url: "ftp://example.test/ignored" },
          ],
        },
      },
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: "The current guide recommends the Responses API.",
            annotations: [
              {
                type: "url_citation",
                url: "https://docs.example.test/guide#citation",
                title: "Web search guide",
              },
              {
                type: "url_citation",
                url_citation: {
                  url: "https://example.test/later",
                  title: "Compatibility notes",
                  content: "A compact provider-supplied excerpt.",
                },
              },
            ],
          },
        ],
      },
    ],
  };

  it("returns the grounded summary and merges citations into the complete source list", () => {
    expect(parseResponsesWebSearch(response)).toEqual({
      summary: "The current guide recommends the Responses API.",
      results: [
        {
          title: "Web search guide",
          url: "https://docs.example.test/guide#overview",
          snippet: "",
        },
        {
          title: "Compatibility notes",
          url: "https://example.test/later",
          snippet: "A compact provider-supplied excerpt.",
        },
      ],
    });
  });

  it("respects the result limit and rejects malformed output", () => {
    expect(parseResponsesWebSearch(response, 1).results).toHaveLength(1);
    expect(parseResponsesWebSearch({})).toEqual({ summary: "", results: [] });
    expect(parseResponsesWebSearch(null)).toEqual({ summary: "", results: [] });
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

  it("collects all result blocks, validates URLs, and de-duplicates fragments before limiting", () => {
    const results = parseAnthropicWebSearch(
      {
        content: [
          {
            type: "web_search_tool_result",
            content: [
              { type: "web_search_result", url: "https://example.test/docs#one", title: "one" },
              { type: "web_search_result", url: "ftp://example.test/file", title: "ftp" },
            ],
          },
          {
            type: "web_search_tool_result",
            content: [
              { type: "web_search_result", url: "https://example.test/docs#two", title: "dup" },
              { type: "web_search_result", url: "https://example.test/later", title: "later" },
            ],
          },
        ],
      },
      2,
    );

    expect(results.map((result) => result.title)).toEqual(["one", "later"]);
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
