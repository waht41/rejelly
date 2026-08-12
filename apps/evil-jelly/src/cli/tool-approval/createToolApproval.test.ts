import { describe, expect, it } from "vitest";
import {
  runWithToolDetailSlot,
  takeActiveToolDetail,
} from "../../shared/tool-observation/invocationContext";
import { resetPromptQueue } from "../bindings/promptQueue";
import { resetOutputSession, useOutputStore } from "../store/useOutputStore";
import { resetPromptSession, usePromptStore } from "../store/usePromptStore";
import { createToolApproval } from "./createToolApproval";

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function resetCliStores(): void {
  resetPromptQueue();
  resetPromptSession();
  resetOutputSession();
}

describe("createToolApproval", () => {
  it("serializes concurrent confirmations so retry feedback cannot orphan an earlier prompt", async () => {
    resetCliStores();
    const confirmWrite = createToolApproval();

    const first = confirmWrite({
      type: "fs_write",
      kind: "edit",
      filePath: "a.ts",
      unifiedDiff: "--- a.ts\n+++ a.ts\n@@\n-old\n+new\n",
      proposedContent: "new\n",
      supportedActions: ["accept", "reject", "retry"],
    });
    const second = confirmWrite({
      type: "fs_write",
      kind: "edit",
      filePath: "b.ts",
      unifiedDiff: "--- b.ts\n+++ b.ts\n@@\n-old\n+new\n",
      proposedContent: "new\n",
      supportedActions: ["accept", "reject", "retry"],
    });

    await flushMicrotasks();
    expect(usePromptStore.getState().prompt).toMatchObject({
      type: "actionMenu",
      message: "Allow edit a.ts?",
    });

    usePromptStore.getState().submitActionChoice("retry");
    await flushMicrotasks();
    expect(usePromptStore.getState().prompt).toMatchObject({
      type: "line",
      label: "Review comments: ",
    });

    usePromptStore.getState().submitLine("please adjust this change");
    await expect(first).resolves.toEqual({
      action: "retry",
      feedback: "please adjust this change",
    });

    await flushMicrotasks();
    expect(usePromptStore.getState().prompt).toMatchObject({
      type: "actionMenu",
      message: "Allow edit b.ts?",
    });

    usePromptStore.getState().submitActionChoice("accept");
    await expect(second).resolves.toEqual({ action: "accept" });
  });

  it("enables session-wide auto-allow after selecting accept_all_session", async () => {
    resetCliStores();
    const confirmWrite = createToolApproval();

    const first = confirmWrite({
      type: "fs_write",
      kind: "edit",
      filePath: "a.ts",
      unifiedDiff: "--- a.ts\n+++ a.ts\n@@\n-old\n+new\n",
      proposedContent: "new\n",
      supportedActions: ["accept", "reject"],
    });

    await flushMicrotasks();
    expect(usePromptStore.getState().prompt).toMatchObject({
      type: "actionMenu",
      message: "Allow edit a.ts?",
    });
    usePromptStore.getState().submitActionChoice("accept_all_session");
    await expect(first).resolves.toEqual({ action: "accept" });

    const second = confirmWrite({
      type: "fs_write",
      kind: "create",
      filePath: "b.ts",
      unifiedDiff: "--- /dev/null\n+++ b.ts\n@@\n+new\n",
      proposedContent: "new\n",
      supportedActions: ["accept", "reject"],
    });
    await expect(second).resolves.toEqual({ action: "accept" });
    expect(usePromptStore.getState().prompt).toMatchObject({ type: "idle" });
  });

  it("supports initial auto-allow policy by kind", async () => {
    resetCliStores();
    const confirmWrite = createToolApproval({
      initialAutoAllow: { delete: true },
    });

    const result = await confirmWrite({
      type: "fs_write",
      kind: "delete",
      filePath: "a.ts",
      unifiedDiff: "--- a.ts\n+++ /dev/null\n@@\n-old\n",
      proposedContent: "",
      supportedActions: ["accept", "reject"],
    });
    expect(result).toEqual({ action: "accept" });
    expect(usePromptStore.getState().prompt).toMatchObject({ type: "idle" });
  });

  it("auto mode accepts fs writes of every kind without prompting", async () => {
    resetCliStores();
    const confirmWrite = createToolApproval({ getMode: () => "auto" });

    const created = await confirmWrite({
      type: "fs_write",
      kind: "create",
      filePath: "a.ts",
      unifiedDiff: "--- /dev/null\n+++ a.ts\n@@\n+new\n",
      proposedContent: "new\n",
      supportedActions: ["accept", "reject"],
    });
    const edited = await confirmWrite({
      type: "fs_write",
      kind: "edit",
      filePath: "a.ts",
      unifiedDiff: "--- a.ts\n+++ a.ts\n@@\n-old\n+new\n",
      proposedContent: "new\n",
      supportedActions: ["accept", "reject"],
    });
    const deleted = await confirmWrite({
      type: "fs_write",
      kind: "delete",
      filePath: "a.ts",
      unifiedDiff: "--- a.ts\n+++ /dev/null\n@@\n-old\n",
      proposedContent: "",
      supportedActions: ["accept", "reject"],
    });

    expect(created).toEqual({ action: "accept" });
    expect(edited).toEqual({ action: "accept" });
    expect(deleted).toEqual({ action: "accept" });
    expect(usePromptStore.getState().prompt).toMatchObject({ type: "idle" });
  });

  it("normal mode still confirms fs writes", async () => {
    resetCliStores();
    const confirmWrite = createToolApproval({ getMode: () => "normal" });

    const pending = confirmWrite({
      type: "fs_write",
      kind: "edit",
      filePath: "a.ts",
      unifiedDiff: "--- a.ts\n+++ a.ts\n@@\n-old\n+new\n",
      proposedContent: "new\n",
      supportedActions: ["accept", "reject"],
    });

    await flushMicrotasks();
    expect(usePromptStore.getState().prompt).toMatchObject({
      type: "actionMenu",
      message: "Allow edit a.ts?",
    });
    // The reviewed diff is committed to scrollback history, not the transient view.
    expect(useOutputStore.getState().history).toContainEqual(
      expect.objectContaining({
        type: "diff",
        diff: { text: "--- a.ts\n+++ a.ts\n@@\n-old\n+new\n" },
      }),
    );
    expect(usePromptStore.getState().view).toEqual({ type: "none" });
    usePromptStore.getState().submitActionChoice("reject");
    await expect(pending).resolves.toEqual({ action: "reject" });
  });

  it("records fs write diffs for tool transcript detail", async () => {
    resetCliStores();
    const confirmWrite = createToolApproval({ getMode: () => "normal" });
    const diff = "--- a.ts\n+++ a.ts\n@@\n-old\n+new\n";

    await runWithToolDetailSlot(async () => {
      const pending = confirmWrite({
        type: "fs_write",
        kind: "edit",
        filePath: "a.ts",
        unifiedDiff: diff,
        proposedContent: "new\n",
        reviewCaption: "Batch edit across 1 files",
        supportedActions: ["accept", "reject"],
      });

      await flushMicrotasks();
      expect(takeActiveToolDetail()).toEqual({
        type: "diff",
        text: diff,
        caption: "Batch edit across 1 files",
      });

      usePromptStore.getState().submitActionChoice("accept");
      await expect(pending).resolves.toEqual({ action: "accept" });
    });
  });

  it("enables shell prefix auto-allow for later commands in this session", async () => {
    resetCliStores();
    const confirmTool = createToolApproval();

    const first = confirmTool({
      type: "shell_command",
      command: "pnpm test src/domains/workspace/write/WriteTools.test.ts",
      cwd: "apps/evil-jelly",
      supportedActions: ["accept", "reject"],
    });

    await flushMicrotasks();
    expect(usePromptStore.getState().prompt).toMatchObject({
      type: "actionMenu",
    });
    usePromptStore.getState().submitActionChoice("accept_shell_prefix");
    await expect(first).resolves.toEqual({ action: "accept" });

    const second = confirmTool({
      type: "shell_command",
      command: "pnpm test src/cli/bindings/hostBindings.test.ts",
      cwd: "apps/evil-jelly",
      supportedActions: ["accept", "reject"],
    });
    await expect(second).resolves.toEqual({ action: "accept" });
    expect(usePromptStore.getState().prompt).toMatchObject({ type: "idle" });
  });

  it("auto-runs a read-only/safe shell command in any mode (incl. normal)", async () => {
    resetCliStores();
    const confirmTool = createToolApproval({ getMode: () => "normal" });

    const result = await confirmTool({
      type: "shell_command",
      command: "git status",
      supportedActions: ["accept", "reject"],
    });

    expect(result).toEqual({ action: "accept" });
    expect(usePromptStore.getState().prompt).toMatchObject({ type: "idle" });
  });

  it("auto mode accepts a confirm-tier command declared reversible", async () => {
    resetCliStores();
    const confirmTool = createToolApproval({ getMode: () => "auto" });

    const result = await confirmTool({
      type: "shell_command",
      command: "pnpm test",
      declaredSafety: "reversible",
      reason: "Runs the test suite without modifying source files.",
      supportedActions: ["accept", "reject"],
    });

    expect(result).toEqual({ action: "accept" });
    expect(usePromptStore.getState().prompt).toMatchObject({ type: "idle" });
  });

  it("states why a shell command was auto-allowed without repeating it", async () => {
    resetCliStores();
    const confirmTool = createToolApproval({ getMode: () => "auto" });
    const command = `node -e "let a = 1;\n  let b = 2;\n  console.log(a + b);"`;

    await confirmTool({
      type: "shell_command",
      command,
      declaredSafety: "read_only",
      reason: "Inspect a JSON field.",
      supportedActions: ["accept", "reject"],
    });

    const notice = useOutputStore
      .getState()
      .history.find((turn) => turn.type === "system" && turn.content.includes("[Auto-allowed]"));
    expect(notice).toBeDefined();
    const content = notice?.type === "system" ? notice.content : "";
    // The reason is the only thing this line says that the tool block does not.
    expect(content).toBe("[Auto-allowed] declared read_only — Inspect a JSON field.");
    expect(content).not.toContain("node -e");
    expect(notice?.type === "system" && notice.oneLine).toBe(true);
  });

  it("still names the target in a filesystem auto-allow notice", async () => {
    resetCliStores();
    const confirmTool = createToolApproval({ getMode: () => "auto" });

    await confirmTool({
      type: "fs_write",
      kind: "edit",
      filePath: "src/a.ts",
      unifiedDiff: "--- a\n+++ b\n@@\n-old\n+new\n",
      proposedContent: "new",
    });

    const notice = useOutputStore
      .getState()
      .history.find((turn) => turn.type === "system" && turn.content.includes("[Auto-allowed]"));
    // Paths are short and there is no reason field to carry the line on its own.
    expect(notice?.type === "system" ? notice.content : "").toContain("src/a.ts");
  });

  it("still shows the full command in the interactive confirmation", async () => {
    resetCliStores();
    const confirmTool = createToolApproval({ getMode: () => "normal" });
    const command = `rm -rf ${"nested/dir/".repeat(40)}build`;

    const pending = confirmTool({
      type: "shell_command",
      command,
      declaredSafety: "read_only",
      reason: "why",
      supportedActions: ["accept", "reject"],
    });

    await flushMicrotasks();
    const prompt = usePromptStore.getState().prompt;
    // Approving something you cannot fully read is the one case where the
    // untruncated command matters.
    expect(prompt.type === "actionMenu" ? prompt.message : "").toContain(command);
    usePromptStore.getState().submitActionChoice("reject");
    await pending;
  });

  it("normal mode still confirms a confirm-tier command even when declared reversible", async () => {
    resetCliStores();
    const confirmTool = createToolApproval({ getMode: () => "normal" });

    const pending = confirmTool({
      type: "shell_command",
      command: "pnpm test",
      declaredSafety: "reversible",
      reason: "Runs the test suite without modifying source files.",
      supportedActions: ["accept", "reject"],
    });

    await flushMicrotasks();
    expect(usePromptStore.getState().prompt).toMatchObject({
      type: "actionMenu",
      message:
        "Run shell command in workspace root?\n⚠ Runs the test suite without modifying source files.\n> pnpm test",
    });
    usePromptStore.getState().submitActionChoice("reject");
    await expect(pending).resolves.toEqual({ action: "reject" });
  });

  it("never auto-runs a block-tier command even when declared read-only", async () => {
    resetCliStores();
    const confirmTool = createToolApproval({ getMode: () => "auto" });

    const pending = confirmTool({
      type: "shell_command",
      command: "rm -rf dist",
      declaredSafety: "read_only",
      reason: "Incorrect model declaration should not bypass host policy.",
      supportedActions: ["accept", "reject"],
    });

    await flushMicrotasks();
    expect(usePromptStore.getState().prompt).toMatchObject({
      type: "actionMenu",
      message:
        "Run shell command in workspace root?\n⚠ Incorrect model declaration should not bypass host policy.\n> rm -rf dist",
    });
    usePromptStore.getState().submitActionChoice("reject");
    await expect(pending).resolves.toEqual({ action: "reject" });
  });

  it("shows the model's declared reason in the shell command prompt when provided", async () => {
    resetCliStores();
    const confirmTool = createToolApproval();

    const pending = confirmTool({
      type: "shell_command",
      command: "pnpm run build",
      reason: "writes output files to dist/",
      supportedActions: ["accept", "reject"],
    });

    await flushMicrotasks();
    expect(usePromptStore.getState().prompt).toMatchObject({
      type: "actionMenu",
      message:
        "Run shell command in workspace root?\n⚠ writes output files to dist/\n> pnpm run build",
    });
    usePromptStore.getState().submitActionChoice("reject");
    await expect(pending).resolves.toEqual({ action: "reject" });
  });

  it("never auto-allows shell commands containing control operators", async () => {
    resetCliStores();
    const confirmTool = createToolApproval({
      initialShellAutoAllowPrefixes: ["pnpm test"],
    });

    const pending = confirmTool({
      type: "shell_command",
      command: "pnpm test && echo hacked",
      cwd: "apps/evil-jelly",
      supportedActions: ["accept", "reject"],
    });

    await flushMicrotasks();
    expect(usePromptStore.getState().prompt).toMatchObject({
      type: "actionMenu",
      message: "Run shell command in apps/evil-jelly?\n> pnpm test && echo hacked",
    });
    usePromptStore.getState().submitActionChoice("reject");
    await expect(pending).resolves.toEqual({ action: "reject" });
  });
});
