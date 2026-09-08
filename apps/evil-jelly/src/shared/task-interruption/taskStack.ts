/**
 * Stack of interruptible tasks shared by agent and tool execution.
 * Interruption policy: abort the active top task only.
 */

export type InterruptibleTaskType = "agent_thinking" | "tool_execution";

export interface InterruptibleTaskRegistration {
  type: InterruptibleTaskType;
  name: string;
  abort?: (reason: string) => void;
}

export interface InterruptedTask {
  type: InterruptibleTaskType;
  name: string;
}

export type TaskInterruptionResult =
  | { status: "idle" }
  | { status: "interrupted"; task: InterruptedTask }
  | { status: "already_interrupted"; task: InterruptedTask };

type InterruptibleTask = InterruptibleTaskRegistration & {
  id: number;
  state: "running" | "interrupting";
};

let taskIdCounter = 0;
let taskStack: InterruptibleTask[] = [];

export function resetInterruptibleTaskStack(reason: string): void {
  const pendingTasks = taskStack.slice();
  taskStack = [];
  for (let i = pendingTasks.length - 1; i >= 0; i -= 1) {
    const pendingTask = pendingTasks[i];
    if (!pendingTask) continue;
    if (pendingTask.state === "running") {
      pendingTask.state = "interrupting";
      pendingTask.abort?.(reason);
    }
  }
  taskIdCounter = 0;
}

export function registerInterruptibleTask(task: InterruptibleTaskRegistration): () => void {
  const entry: InterruptibleTask = {
    id: ++taskIdCounter,
    state: "running",
    ...task,
  };
  taskStack.push(entry);
  return () => {
    const index = taskStack.findIndex((item) => item.id === entry.id);
    if (index >= 0) {
      taskStack.splice(index, 1);
    }
  };
}

export function hasActiveInterruptibleTask(): boolean {
  return taskStack.length > 0;
}

export function interruptActiveTask(reason: string): TaskInterruptionResult {
  const topTask = taskStack.at(-1);
  if (!topTask) {
    return { status: "idle" };
  }

  const task = {
    type: topTask.type,
    name: topTask.name,
  };
  if (topTask.state === "interrupting") {
    return { status: "already_interrupted", task };
  }

  topTask.state = "interrupting";
  topTask.abort?.(reason);
  return { status: "interrupted", task };
}
