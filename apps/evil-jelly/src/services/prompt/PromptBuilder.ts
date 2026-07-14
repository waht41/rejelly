/**
 * Composes system-style prompts from blocks and lists; blocks are joined with \n\n only.
 */

export type AddListOptions = {
  /** Optional heading line placed above the list. */
  title?: string;
  /** `numbered` → `1. …`; `bullet` → `- …`. Defaults to numbered. */
  style?: "numbered" | "bullet";
};

export class PromptBuilder {
  private blocks: string[] = [];

  /** Append a paragraph; skips empty string, null, undefined, or false. */
  addBlock(content?: string | false | null): this {
    if (content) {
      this.blocks.push(content);
    }
    return this;
  }

  /**
   * If condition is truthy, runs action on this builder (multi-step branches without breaking the chain).
   */
  when(condition: unknown, action: (builder: this) => void): this {
    if (condition) {
      action(this);
    }
    return this;
  }

  /**
   * Inserts reusable build logic (plugin-style); action always runs, unlike when.
   */
  addAction(action: (builder: this) => void): this {
    action(this);
    return this;
  }

  /**
   * List block; falsy entries are dropped. Examples: `Rules:\n1. …` (numbered) or `Rules:\n- …` (bullet).
   */
  addList(items: (string | false | undefined | null)[], options?: AddListOptions): this {
    const validItems = items.filter((item): item is string => !!item);
    if (validItems.length === 0) {
      return this;
    }

    const style = options?.style ?? "numbered";
    const listBlock =
      style === "bullet"
        ? validItems.map((item) => `- ${item}`).join("\n")
        : validItems.map((item, index) => `${index + 1}. ${item}`).join("\n");

    const title = options?.title;
    const content = title ? `${title}\n${listBlock}` : listBlock;

    this.blocks.push(content);
    return this;
  }

  /**
   * One XML-like block. Skips only when content is null or undefined.
   * Empty string body renders as self-closing `<tag … />`; non-empty wraps as `<tag>…</tag>`.
   */
  addXmlBlock(
    tag: string,
    content: string | undefined | null,
    attributes?: Record<string, string>,
  ): this {
    if (content === undefined || content === null) {
      return this;
    }

    let attrString = "";
    if (attributes) {
      attrString = Object.entries(attributes)
        .map(([k, v]) => ` ${k}="${this.escapeXmlAttr(v)}"`)
        .join("");
    }

    if (content === "") {
      this.blocks.push(`<${tag}${attrString} />`);
    } else {
      this.blocks.push(`<${tag}${attrString}>\n${content}\n</${tag}>`);
    }
    return this;
  }

  private escapeXmlAttr(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  /** Final prompt: blocks separated by double newlines only. */
  build(): string {
    return this.blocks.join("\n\n");
  }
}
