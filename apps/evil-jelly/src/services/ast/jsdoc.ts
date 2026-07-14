export function extractJsDocAbove(lines: string[], declLine1Based: number): string | undefined {
  const idx = declLine1Based - 1;
  if (idx <= 0) {
    return undefined;
  }
  let end = idx - 1;
  while (end >= 0 && lines[end].trim() === "") {
    end--;
  }
  if (end < 0) {
    return undefined;
  }
  const line = lines[end].trim();
  if (!line.startsWith("/**")) {
    return undefined;
  }
  const block: string[] = [];
  let i = end;
  while (i >= 0) {
    block.unshift(lines[i]);
    if (lines[i].includes("*/")) {
      break;
    }
    i--;
  }
  if (!block.some((l) => l.includes("*/"))) {
    return undefined;
  }
  return block.join("\n").trim();
}

/**
 * First leading JSDoc block at file start (after optional shebang / blank lines).
 * Used for module-level overview text that is not attached to a single declaration line.
 */
export function extractLeadingFileJsDoc(lines: string[]): string | undefined {
  let i = 0;
  if (lines[0]?.trim().startsWith("#!")) {
    i = 1;
  }
  while (i < lines.length && lines[i].trim() === "") {
    i++;
  }
  if (i >= lines.length) {
    return undefined;
  }
  const trimmed = lines[i].trim();
  if (!trimmed.startsWith("/**")) {
    return undefined;
  }
  const block: string[] = [];
  let j = i;
  while (j < lines.length) {
    block.push(lines[j]);
    if (lines[j].includes("*/")) {
      break;
    }
    j++;
  }
  if (!block.some((l) => l.includes("*/"))) {
    return undefined;
  }
  return block.join("\n").trim();
}
