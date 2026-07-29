import { describe, expect, it } from "vitest";
import {
  escapePseudoXmlAttribute,
  renderPseudoXmlElement,
  selectPseudoXmlBoundaryTag,
  unwrapPseudoXmlElement,
} from "./pseudoXml";

describe("pseudo XML payloads", () => {
  it("keeps ordinary bodies byte-for-byte unchanged", () => {
    const body = 'const view = <Panel title="A & B" />;\n';

    expect(renderPseudoXmlElement("file", body, { path: 'src/"view".tsx' })).toBe(
      '<file path="src/&quot;view&quot;.tsx">\n' + body + "\n</file>",
    );
  });

  it("uses a deterministic alternate boundary when the body contains the closing tag", () => {
    const body = "literal </file> remains file content";
    const first = renderPseudoXmlElement("file", body);
    const second = renderPseudoXmlElement("file", body);
    const tag = selectPseudoXmlBoundaryTag("file", body);

    expect(tag).toMatch(/^file-[a-f0-9]{8}$/);
    expect(first).toBe(second);
    expect(first).toBe(`<${tag}>\n${body}\n</${tag}>`);
    expect(first).toContain(body);
  });

  it("unwraps both default and content-derived boundaries", () => {
    const ordinary = renderPseudoXmlElement("prior_user_message", "fix it");
    const colliding = renderPseudoXmlElement(
      "prior_user_message",
      "explain </prior_user_message> literally",
    );

    expect(unwrapPseudoXmlElement(ordinary, "prior_user_message")).toBe("fix it");
    expect(unwrapPseudoXmlElement(colliding, "prior_user_message")).toBe(
      "explain </prior_user_message> literally",
    );
  });

  it("escapes attributes without changing body text", () => {
    expect(escapePseudoXmlAttribute('A & "B" < C > D')).toBe("A &amp; &quot;B&quot; &lt; C &gt; D");
  });
});
