import { type AgentMiddleware, getAbortHandle } from "@rejelly/core";
import { pushRuntimeTask } from "./runtimeControl";

export function withAbort<Props = unknown, Result = unknown>(): AgentMiddleware<Props, Result> {
  return {
    name: "withAbort",
    handler: async (ctx, next) => {
      const abortCurrentAgent = getAbortHandle();
      const popTask = pushRuntimeTask({
        type: "agent_thinking",
        name: ctx.agentId,
        abort: (reason) => {
          abortCurrentAgent(new Error(reason || "Stopped by user (/stop or Esc)"));
        },
      });

      try {
        return await next();
      } finally {
        popTask();
      }
    },
  };
}
