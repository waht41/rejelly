export type Page = "issues" | "investigations";

export type LoadState<T> =
  | { status: "loading" }
  | { status: "loaded"; data: T }
  | { status: "error"; error: string };
