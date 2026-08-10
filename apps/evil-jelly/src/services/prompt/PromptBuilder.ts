/**
 * Composes system-style prompts from blocks and lists; blocks are joined with \n\n only.
 */

import { type PseudoXmlAttributes, renderPseudoXmlElement } from "../../shared/lib/pseudoXml";

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
   * Inserts reusable build logic; action always runs, unlike when.
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

  /** One semantic XML-like block with an unmodified, directly copyable body. */
  addPseudoXmlBlock(
    tag: string,
    content: string | undefined | null,
    attributes?: PseudoXmlAttributes,
  ): this {
    if (content === undefined || content === null) {
      return this;
    }

    this.blocks.push(renderPseudoXmlElement(tag, content, attributes));
    return this;
  }

  /** Final prompt: blocks separated by double newlines only. */
  build(): string {
    return this.blocks.join("\n\n");
  }
}
