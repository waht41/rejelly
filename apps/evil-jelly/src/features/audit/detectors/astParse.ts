import { parse, type SgNode } from "@ast-grep/napi";
import { langFromRelPath } from "../../../domains/workspace/source/sourceLanguage";

export function tryParseRoot(file: string, code: string): SgNode | null {
  try {
    return parse(langFromRelPath(file), code).root();
  } catch {
    return null;
  }
}
