const DEFAULT_EXCERPT_RADIUS = 80;

export interface FieldHit {
  path: string;
  excerpt: string;
}

export interface CollectFieldHitsOptions {
  maxHits: number;
  excerptRadius?: number;
}

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function excerptAround(text: string, index: number, needleLength: number, radius: number): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + needleLength + radius);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${compact(text.slice(start, end))}${suffix}`;
}

export function collectFieldHits(
  value: unknown,
  needle: string,
  path: string,
  hits: FieldHit[],
  options: CollectFieldHitsOptions,
): void {
  if (hits.length >= options.maxHits) return;

  if (typeof value === "string") {
    const index = value.toLowerCase().indexOf(needle);
    if (index >= 0) {
      hits.push({
        path,
        excerpt: excerptAround(
          value,
          index,
          needle.length,
          options.excerptRadius ?? DEFAULT_EXCERPT_RADIUS,
        ),
      });
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      collectFieldHits(item, needle, `${path}[${index}]`, hits, options);
      if (hits.length >= options.maxHits) return;
    }
    return;
  }

  if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      collectFieldHits(item, needle, path ? `${path}.${key}` : key, hits, options);
      if (hits.length >= options.maxHits) return;
    }
  }
}

export function findFieldHits(
  value: unknown,
  needle: string,
  options: CollectFieldHitsOptions,
  path = "",
): FieldHit[] {
  const hits: FieldHit[] = [];
  collectFieldHits(value, needle, path, hits, options);
  return hits;
}
