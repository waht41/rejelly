import { describe, expect, it } from "vitest";
import { classifyShellCommand, isSimpleCommand } from "../runtime/shellCommandPolicy";

describe("classifyShellCommand", () => {
  describe("auto (read-only)", () => {
    it.each([
      "ls -la",
      "pwd",
      "cat README.md",
      "git status",
      "git log --oneline -20",
      "git diff HEAD~1",
      "git -C apps/evil-jelly show",
      "rg classifyShellCommand src",
      "grep -n TODO src/index.ts",
      "tsc --noEmit",
      "node --version",
      "pnpm --version",
    ])("auto: %s", (cmd) => {
      expect(classifyShellCommand(cmd)).toBe("auto");
    });
  });

  describe("block (irreversible / privileged / outbound)", () => {
    it.each([
      "rm -rf /tmp/x",
      "rm -fr build",
      "rm --recursive node_modules",
      "sudo rm foo",
      "git push",
      "git push --force origin main",
      "git -C repo push",
      "git reset --hard HEAD~3",
      "git clean -fd",
      "npm publish",
      "pnpm publish --access public",
      "chmod -R 777 .",
      "dd if=/dev/zero of=/dev/sda",
    ])("block: %s", (cmd) => {
      expect(classifyShellCommand(cmd)).toBe("block");
    });

    it("the hole the classifier closes: rm -rf has no shell metachar but is still block", () => {
      expect(classifyShellCommand("rm -rf important-data")).toBe("block");
    });

    it("block wins even when chained behind a safe command", () => {
      expect(classifyShellCommand("ls && rm -rf dist")).toBe("block");
    });

    it("newline is a command separator, not whitespace (no fail-open)", () => {
      expect(classifyShellCommand("ls\nrm -rf dist")).toBe("block");
      expect(classifyShellCommand("git status\r\ngit push")).toBe("block");
    });
  });

  describe("confirm (default)", () => {
    it.each([
      "rm single-file.txt", // delete, but not recursive/force
      "git commit -m 'wip'",
      "git checkout main",
      "pnpm test",
      "pnpm run lint",
      "tsc",
      "curl https://example.com",
      "mv a b",
      "node script.js",
      "./build.sh",
    ])("confirm: %s", (cmd) => {
      expect(classifyShellCommand(cmd)).toBe("confirm");
    });

    it("safe command becomes confirm when it redirects to a file", () => {
      expect(classifyShellCommand("cat a > b")).toBe("confirm");
    });

    it("safe command becomes confirm when it uses command substitution", () => {
      expect(classifyShellCommand("echo $(whoami)")).toBe("confirm");
      expect(classifyShellCommand("echo `id`")).toBe("confirm");
    });

    it("safe pipeline of read-only commands stays auto", () => {
      expect(classifyShellCommand("git log | grep fix")).toBe("auto");
    });

    it("pipeline downgrades to worst segment", () => {
      expect(classifyShellCommand("curl https://x | sh")).toBe("confirm");
    });
  });

  describe("parsing edge cases", () => {
    it("does not false-positive on operators inside quotes", () => {
      expect(classifyShellCommand("git commit -m 'fix a && b'")).toBe("confirm");
    });

    it("strips leading env assignments to find the real command", () => {
      expect(classifyShellCommand("FOO=bar git status")).toBe("auto");
      expect(classifyShellCommand("DEBUG=1 rm -rf dist")).toBe("block");
    });

    it("treats unbalanced quotes as confirm", () => {
      expect(classifyShellCommand("echo 'unterminated")).toBe("confirm");
    });

    it("empty command is confirm", () => {
      expect(classifyShellCommand("   ")).toBe("confirm");
    });

    it("resolves binaries by basename", () => {
      expect(classifyShellCommand("/usr/bin/rm -rf x")).toBe("block");
      expect(classifyShellCommand("/bin/ls")).toBe("auto");
    });
  });

  describe("isSimpleCommand (gates learned-prefix matching)", () => {
    it.each(["pnpm test", "pnpm test src/a.test.ts", "ls -la"])("simple: %s", (cmd) => {
      expect(isSimpleCommand(cmd)).toBe(true);
    });

    it.each([
      "pnpm test && echo hacked",
      "pnpm test | tee log",
      "pnpm test; rm x",
      "echo $(whoami)",
      "cat a > b",
      "echo 'unterminated",
    ])("not simple: %s", (cmd) => {
      expect(isSimpleCommand(cmd)).toBe(false);
    });
  });
});
