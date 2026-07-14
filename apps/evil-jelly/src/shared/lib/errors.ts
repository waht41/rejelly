export function getErrnoCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}
