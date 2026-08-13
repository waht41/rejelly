export type RunLoopIntent =
  | { type: "exit" }
  | { type: "new_session" }
  | { type: "resume"; sessionId: string }
  | { type: "none" };

export interface RunSegmentControl {
  registerAbort: (handler: (reason: string) => void) => () => void;
  requestAbort: (reason: string) => boolean;
}

export interface RunLoopControl {
  request: (intent: Exclude<RunLoopIntent, { type: "none" }>) => void;
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
