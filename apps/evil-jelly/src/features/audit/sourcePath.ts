const TEST_OR_GENERATED_RE =
  /(^|\/)(__tests__|__fixtures__|__snapshots__|__mocks__|node_modules|dist|build|coverage|\.turbo)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$|\.gen\.[cm]?[jt]sx?$|\.d\.ts$|(^|\/)generated(\/|$)/;

/** Whether a path is intentional boilerplate rather than an actionable audit target. */
export function isTestOrGeneratedPath(file: string): boolean {
  return TEST_OR_GENERATED_RE.test(file);
}
