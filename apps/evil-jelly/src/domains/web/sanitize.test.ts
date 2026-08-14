import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "./sanitize";

describe("htmlToMarkdown", () => {
  it("preserves preformatted code as a fenced block", () => {
    const result = htmlToMarkdown(`
      <main>
        <pre><code class="language-ts"><span>const value = 1;</span>
  <span>value += 1;</span>

<span>console.log(value);</span></code></pre>
      </main>
    `);

    expect(result.markdown).toContain(
      "```ts\nconst value = 1;\n  value += 1;\n\nconsole.log(value);\n```",
    );
  });

  it("handles VitePress code wrappers, line-number gutters, and zero-width anchors", () => {
    const result = htmlToMarkdown(`
      <main>
        <h1>Example <a class="header-anchor" href="#example">&#8203;</a></h1>
        <div class="language-typescript vp-adaptive-theme line-numbers-mode">
          <button title="Copy Code">Copy</button>
          <pre class="shiki"><code><span class="line"><span>const</span> first = 1;</span>
<span class="line"><span>const</span> second = 2;</span></code></pre>
          <div class="line-numbers-wrapper" aria-hidden="true"><span>1</span><br><span>2</span></div>
        </div>
      </main>
    `);

    expect(result.markdown).toContain("# Example");
    expect(result.markdown).toContain("```typescript\nconst first = 1;\nconst second = 2;\n```");
    expect(result.markdown).not.toMatch(/(?:^|\n)1\s*\n2(?:\n|$)/);
    expect(result.markdown).not.toMatch(/(?:\u200B|\u200C|\u200D|\uFEFF)/);
  });

  it("keeps ordinary code elements inline", () => {
    const result = htmlToMarkdown("<main><p>Run <code>pnpm test</code> now.</p></main>");

    expect(result.markdown).toBe("Run `pnpm test` now.");
  });
});
