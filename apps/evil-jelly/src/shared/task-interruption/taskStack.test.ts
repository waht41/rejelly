import { describe, expect, it } from "vitest";
import {
  hasActiveInterruptibleTask,
  interruptActiveTask,
  registerInterruptibleTask,
  resetInterruptibleTaskStack,
} from "./taskStack";

describe("interruptible task stack", () => {
  it("aborts pending tasks before resetting stack", () => {
    resetInterruptibleTaskStack("test setup");
    const calls: string[] = [];
    registerInterruptibleTask({
      type: "agent_thinking",
      name: "main_agent_run",
      abort: (reason) => calls.push(`agent:${reason}`),
    });
    registerInterruptibleTask({
      type: "tool_execution",
      name: "run_command",
      abort: (reason) => calls.push(`tool:${reason}`),
    });

    resetInterruptibleTaskStack("session reset");

    expect(calls).toEqual(["tool:session reset", "agent:session reset"]);
    expect(interruptActiveTask("user stop")).toEqual({ interrupted: false });
  });

  it("reports whether any interruptible task is active", () => {
    resetInterruptibleTaskStack("test setup");
    expect(hasActiveInterruptibleTask()).toBe(false);

    const unregister = registerInterruptibleTask({
      type: "agent_thinking",
      name: "main_agent_run",
    });

    expect(hasActiveInterruptibleTask()).toBe(true);
    unregister();
    expect(hasActiveInterruptibleTask()).toBe(false);
  });

  it("aborts only the top task", () => {
    resetInterruptibleTaskStack("test setup");
    const calls: string[] = [];
    const unregisterAgent = registerInterruptibleTask({
      type: "agent_thinking",
      name: "main_agent_run",
      abort: (reason) => calls.push(`agent:${reason}`),
    });
    const unregisterTool = registerInterruptibleTask({
      type: "tool_execution",
      name: "run_command",
      abort: (reason) => calls.push(`tool:${reason}`),
    });

    const result = interruptActiveTask("user requested stop");

    expect(result).toEqual({
      interrupted: true,
      task: { type: "tool_execution", name: "run_command" },
    });
    expect(calls).toEqual(["tool:user requested stop"]);
    unregisterTool();
    unregisterAgent();
  });

  it("falls back to agent task after tool is unregistered", () => {
    resetInterruptibleTaskStack("test setup");
    const calls: string[] = [];
    const unregisterAgent = registerInterruptibleTask({
      type: "agent_thinking",
      name: "main_agent_run",
      abort: (reason) => calls.push(`agent:${reason}`),
    });
    const unregisterTool = registerInterruptibleTask({
      type: "tool_execution",
      name: "run_command",
      abort: (reason) => calls.push(`tool:${reason}`),
    });
    unregisterTool();

    const result = interruptActiveTask("escape pressed");

    expect(result).toEqual({
      interrupted: true,
      task: { type: "agent_thinking", name: "main_agent_run" },
    });
    expect(calls).toEqual(["agent:escape pressed"]);
    unregisterAgent();
  });
});
