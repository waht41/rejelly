import { type AgentMiddleware, getAbortHandle } from "@rejelly/core";
import { registerInterruptibleTask } from "../../shared/task-interruption/taskStack";

export function withAbort<Props = unknown, Result = unknown>(): AgentMiddleware<Props, Result> {
  return {
    name: "withAbort",
    handler: async (ctx, next) => {
      const abortCurrentAgent = getAbortHandle();
      const unregisterTask = registerInterruptibleTask({
        type: "agent_thinking",
        name: ctx.agentId,
        abort: (reason) => {
          abortCurrentAgent(new Error(reason || "Stopped by user (/stop or Esc)"));
        },
      });

      try {
        return await next();
      } finally {
        unregisterTask();
      }
    },
  };
}
