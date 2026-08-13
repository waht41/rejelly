import type {
  ConversationLoopControl,
  ConversationLoopIntent,
} from "../../../unified-conversation/MainCliAgent";

export type RunLoopIntent = ConversationLoopIntent | { type: "none" };

export interface RunSegmentControl {
  registerAbort: (handler: (reason: string) => void) => () => void;
  requestAbort: (reason: string) => boolean;
}

export interface RunLoopControl extends ConversationLoopControl {
  take: () => RunLoopIntent;
}

export interface InteractiveRunControl {
  segment: RunSegmentControl;
  loop: RunLoopControl;
}

export function createInteractiveRunControl(): InteractiveRunControl {
  let abortHandler: ((reason: string) => void) | undefined;
  let pendingIntent: RunLoopIntent = { type: "none" };

  return {
    segment: {
      registerAbort: (handler) => {
        abortHandler = handler;
        return () => {
          if (abortHandler === handler) {
            abortHandler = undefined;
          }
        };
      },
      requestAbort: (reason) => {
        if (!abortHandler) return false;
        abortHandler(reason);
        return true;
      },
    },
    loop: {
      request: (intent) => {
        pendingIntent = intent;
      },
      take: () => {
        const intent = pendingIntent;
        pendingIntent = { type: "none" };
        return intent;
      },
    },
  };
}
