import crypto from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveWorkspaceDir,
  workspaceBucket as sessionWorkspaceBucket,
} from "../domains/session/journal/sessionPaths";
import { workspaceBucket } from "./workspaceBucket";

describe("shared workspace bucket identity", () => {
  it("preserves the existing session naming algorithm and export", () => {
    const root = path.resolve("example project");
    const expected = `example_project-${crypto.createHash("sha1").update(root).digest("hex").slice(0, 8)}`;
    expect(workspaceBucket(root)).toBe(expected);
    expect(sessionWorkspaceBucket).toBe(workspaceBucket);
    expect(resolveWorkspaceDir(root, "sessions")).toBe(path.join("sessions", expected));
  });

  it("uses absolute roots to distinguish equal basenames in different projects", () => {
    expect(workspaceBucket("one/project")).not.toBe(workspaceBucket("two/project"));
    expect(workspaceBucket("one/project")).toBe(workspaceBucket(path.resolve("one/project")));
  });
});
