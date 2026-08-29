type StartupReadyTask = () => void;

const pendingTasks = new Set<StartupReadyTask>();
let inputReady = false;

/** Registers non-critical work that must stay out of the startup path. */
export function registerStartupReadyTask(task: StartupReadyTask): () => void {
  if (inputReady) {
    setImmediate(task);
    return () => undefined;
  }
  pendingTasks.add(task);
  return () => pendingTasks.delete(task);
}

/** Runs registered work after the first input-ready call stack yields. */
export function dispatchStartupReadyTasks(): void {
  if (inputReady) return;
  inputReady = true;
  const tasks = [...pendingTasks];
  pendingTasks.clear();
  setImmediate(() => {
    for (const task of tasks) task();
  });
}
