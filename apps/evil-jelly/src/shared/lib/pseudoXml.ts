import { createHash } from "node:crypto";

const XML_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;

export type PseudoXmlAttributes = Readonly<Record<string, string>>;

function assertXmlName(name: string): void {
  if (!XML_NAME.test(name)) {
    throw new Error(`Invalid XML-like name: ${name}`);
  }
}

export function escapePseudoXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderAttributes(attributes?: PseudoXmlAttributes): string {
  if (!attributes) {
    return "";
  }
  return Object.entries(attributes)
    .map(([name, value]) => {
      assertXmlName(name);
      return ` ${name}="${escapePseudoXmlAttribute(value)}"`;
    })
    .join("");
}

/**
 * Pick a stable XML-like tag whose closing marker does not occur in the raw body.
 *
 * The body is model-facing text, not XML parser input, so it must remain byte-for-byte
 * copyable. A content-derived suffix changes only the structural marker when the default
 * closing tag would collide with that body.
 */
export function selectPseudoXmlBoundaryTag(baseTag: string, body: string): string {
  assertXmlName(baseTag);
  if (!body.includes(`</${baseTag}>`)) {
    return baseTag;
  }

  const digest = createHash("sha256").update(`${baseTag}\0${body}`).digest("hex").slice(0, 8);
  let attempt = 0;
  while (true) {
    const suffix = attempt === 0 ? digest : `${digest}-${attempt}`;
    const candidate = `${baseTag}-${suffix}`;
    if (!body.includes(`</${candidate}>`)) {
      return candidate;
    }
    attempt += 1;
  }
}

/**
 * Render a semantic XML-like envelope while leaving its body completely untouched.
 * This deliberately is not guaranteed to be parseable XML.
 */
export function renderPseudoXmlElement(
  baseTag: string,
  body: string,
  attributes?: PseudoXmlAttributes,
): string {
  const boundaryTag = selectPseudoXmlBoundaryTag(baseTag, body);
  return `<${boundaryTag}${renderAttributes(attributes)}>\n${body}\n</${boundaryTag}>`;
}

/** Unwrap an element produced by renderPseudoXmlElement when it has no attributes. */
export function unwrapPseudoXmlElement(value: string, baseTag: string): string | undefined {
  assertXmlName(baseTag);
  const trimmed = value.trim();
  const firstNewline = trimmed.indexOf("\n");
  if (firstNewline < 0) {
    return undefined;
  }
  const openingText = trimmed.slice(0, firstNewline);
  const opening = openingText.match(new RegExp(`^<(${baseTag}(?:-[a-f0-9]{8}(?:-\\d+)?)?)>$`));
  if (!opening) {
    return undefined;
  }
  const tag = opening[1]!;
  const close = `</${tag}>`;
  if (!trimmed.endsWith(close)) {
    return undefined;
  }
  const bodyWithTrailingNewline = trimmed.slice(firstNewline + 1, -close.length);
  return bodyWithTrailingNewline.endsWith("\n")
    ? bodyWithTrailingNewline.slice(0, -1)
    : bodyWithTrailingNewline;
}
