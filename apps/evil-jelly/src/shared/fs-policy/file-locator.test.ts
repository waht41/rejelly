import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  fileLocatorAttributes,
  fileLocatorFromResolved,
  fileLocatorFromUserPath,
} from "./file-locator";

describe("file locators", () => {
  const workspaceRoot = path.resolve("workspace-root");

  it("normalizes workspace paths to project-relative POSIX paths", () => {
    expect(
      fileLocatorFromResolved({
        abs: path.join(workspaceRoot, "apps", "evil-jelly", "src", "index.ts"),
        rel: path.join("apps", "evil-jelly", "src", "index.ts"),
        displayPath: "presentation-only",
        outside: false,
      }),
    ).toEqual({
      scope: "workspace",
      path: "apps/evil-jelly/src/index.ts",
    });
  });

  it("normalizes absolute inputs inside the workspace to workspace locators", () => {
    expect(
      fileLocatorFromUserPath(workspaceRoot, path.join(workspaceRoot, "src", "index.ts")),
    ).toEqual({
      scope: "workspace",
      path: "src/index.ts",
    });
  });

  it("keeps outside paths absolute and marks their scope", () => {
    const outside = path.resolve(workspaceRoot, "..", "shared", "README.md");
    const locator = fileLocatorFromUserPath(workspaceRoot, outside);

    expect(locator).toEqual({
      scope: "absolute",
      path: outside.replace(/\\/g, "/"),
    });
    expect(fileLocatorAttributes(locator)).toEqual({
      path: outside.replace(/\\/g, "/"),
      "path-scope": "absolute",
    });
  });
});
