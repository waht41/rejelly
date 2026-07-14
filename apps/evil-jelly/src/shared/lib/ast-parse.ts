import { parse, type SgNode } from "@ast-grep/napi";
import { langFromRelPath } from "./path";

export function tryParseRoot(file: string, code: string): SgNode | null {
  try {
    return parse(langFromRelPath(file), code).root();
  } catch {
    return null;
  }
}
