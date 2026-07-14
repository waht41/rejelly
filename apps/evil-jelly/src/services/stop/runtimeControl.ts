/**
 * Runtime task stack for non-blocking `/stop`.
 * Stop policy: abort the active top task only.
 */

export interface RuntimeTaskRegistration {
  type: "agent_thinking" | "tool_execution";
  name: string;
  abort?: (reason: string) => void;
}

type RuntimeTask = RuntimeTaskRegistration & { id: number };

let taskIdCounter = 0;
let taskStack: RuntimeTask[] = [];

function formatTaskLabel(task: RuntimeTask): string {
  return `[${task.type}] ${task.name}`;
}

export function resetRuntimeTaskStack(): void {
  const pendingTasks = taskStack.slice();
  taskStack = [];
  for (let i = pendingTasks.length - 1; i >= 0; i -= 1) {
    const pendingTask = pendingTasks[i];
    if (!pendingTask) continue;
    pendingTask.abort?.("Runtime task stack reset");
  }
  taskIdCounter = 0;
}

export function pushRuntimeTask(task: RuntimeTaskRegistration): () => void {
  const entry: RuntimeTask = {
    id: ++taskIdCounter,
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

export function hasRuntimeTask(): boolean {
  return taskStack.length > 0;
}

export function requestRuntimeStop(): string {
  const topTask = taskStack.at(-1);
  if (!topTask) {
    return "[System] Nothing to stop right now.";
  }

  topTask.abort?.("Stopped by user (/stop or Esc)");
  return `[System] Interrupted active task ${formatTaskLabel(topTask)}.`;
}
