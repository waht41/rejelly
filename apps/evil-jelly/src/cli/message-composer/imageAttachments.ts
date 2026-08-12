const IMAGE_TOKEN = /\[Image #(\d+)\]/g;

export function imageToken(index: number): string {
  return `[Image #${index}]`;
}

export function shiftImageTokens(text: string, offset: number): string {
  if (offset <= 0) {
    return text;
  }
  return text.replace(IMAGE_TOKEN, (token, rawIndex: string) => {
    const index = Number.parseInt(rawIndex, 10);
    return Number.isFinite(index) ? imageToken(index + offset) : token;
  });
}

/** Images whose inline tokens survive in the submitted text, in first-seen order. */
export function attachedImages(text: string, images: string[]): string[] {
  const indices = [...text.matchAll(IMAGE_TOKEN)].map((match) => Number(match[1]));
  return [...new Set(indices)]
    .map((index) => images[index - 1])
    .filter((path): path is string => Boolean(path));
}
