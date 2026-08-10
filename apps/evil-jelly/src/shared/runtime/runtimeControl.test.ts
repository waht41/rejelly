import { describe, expect, it } from "vitest";
import {
  hasRuntimeTask,
  pushRuntimeTask,
  requestRuntimeStop,
  resetRuntimeTaskStack,
} from "./runtimeControl";

describe("runtimeControl task stack", () => {
  it("aborts pending tasks before resetting stack", () => {
    resetRuntimeTaskStack();
    const calls: string[] = [];
    pushRuntimeTask({
      type: "agent_thinking",
      name: "main_agent_run",
      abort: (reason) => calls.push(`agent:${reason}`),
    });
    pushRuntimeTask({
      type: "tool_execution",
      name: "run_command",
      abort: (reason) => calls.push(`tool:${reason}`),
    });

    resetRuntimeTaskStack();

    expect(calls).toEqual(["tool:Runtime task stack reset", "agent:Runtime task stack reset"]);
    expect(requestRuntimeStop()).toBe("[System] Nothing to stop right now.");
  });

  it("reports whether any runtime task is active", () => {
    resetRuntimeTaskStack();
    expect(hasRuntimeTask()).toBe(false);

    const pop = pushRuntimeTask({
      type: "agent_thinking",
      name: "main_agent_run",
    });

    expect(hasRuntimeTask()).toBe(true);
    pop();
    expect(hasRuntimeTask()).toBe(false);
  });

  it("aborts only the top task", () => {
    resetRuntimeTaskStack();
    const calls: string[] = [];
    const popAgent = pushRuntimeTask({
      type: "agent_thinking",
      name: "main_agent_run",
      abort: (reason) => calls.push(`agent:${reason}`),
    });
    const popTool = pushRuntimeTask({
      type: "tool_execution",
      name: "run_command",
      abort: (reason) => calls.push(`tool:${reason}`),
    });

    const message = requestRuntimeStop();

    expect(message).toContain("[tool_execution] run_command");
    expect(calls).toEqual(["tool:Stopped by user (/stop or Esc)"]);
    popTool();
    popAgent();
  });

  it("falls back to agent task after tool is popped", () => {
    resetRuntimeTaskStack();
    const calls: string[] = [];
    const popAgent = pushRuntimeTask({
      type: "agent_thinking",
      name: "main_agent_run",
      abort: (reason) => calls.push(`agent:${reason}`),
    });
    const popTool = pushRuntimeTask({
      type: "tool_execution",
      name: "run_command",
      abort: (reason) => calls.push(`tool:${reason}`),
    });
    popTool();

    const message = requestRuntimeStop();

    expect(message).toContain("[agent_thinking] main_agent_run");
    expect(calls).toEqual(["agent:Stopped by user (/stop or Esc)"]);
    popAgent();
  });
});
