import type { EvilJellyBindings } from "../shared/host/bindings";
import type { FsOutsideAccessPayload } from "../shared/host/toolConfirmationBindings";

export function createTestHostBindings(options: {
  mode?: "normal" | "auto";
  outsideAccessRequests?: FsOutsideAccessPayload[];
}): EvilJellyBindings {
  return {
    getInput: async () => ({ text: "" }),
    printOut: () => {},
    logUserMessage: () => {},
    logAssistantMessage: () => {},
    logSystemEvent: () => {},
    logToolBlock: () => {},
    confirmTool: async (params) => {
      if (params.type === "fs_outside_access") {
        options.outsideAccessRequests?.push(params);
      }
      return { action: "accept" };
    },
    requestChoice: async ({ options }) => options[0]?.value ?? "",
    getAgentMode: () => options.mode ?? "normal",
  };
}
