import type { ModelAdapter } from "@rejelly/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestRunAbort } from "../../../services/stop/runControl";
import type { EvilJellyHostBindings } from "../../../shared/types";
import { runEvilJellyHost } from "./runHost";

const mocks = vi.hoisted(() => ({
  mainCliAgent: vi.fn(),
  openSessionRecorder: vi.fn(),
  runWithReview: vi.fn(),
}));

vi.mock("../../../shell/MainCliAgent", () => ({
  MainCliAgent: mocks.mainCliAgent,
}));

vi.mock("../../../services/session/sessionRecorder", () => ({
  openSessionRecorder: mocks.openSessionRecorder,
}));

vi.mock("../../../shared/fs-policy/workspace-fs-policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../shared/fs-policy/workspace-fs-policy")>()),
  getWorkspaceFsPolicy: () => ({ getRoot: () => "/workspace" }),
}));

vi.mock("../../../shared/lib/traceId", () => ({
  generateTraceId: () => "trace-id",
}));

vi.mock("./runWithReview", () => ({
  runWithReview: mocks.runWithReview,
}));

describe("runEvilJellyHost session teardown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ends an idle Ctrl+C run as interrupted before closing the writer", async () => {
    const endSegment = vi.fn();
    const close = vi.fn();
    mocks.openSessionRecorder.mockResolvedValue({
      ended: false,
      endSegment,
      close,
    });
    mocks.mainCliAgent.mockReturnValue(new Promise(() => undefined));
    mocks.runWithReview.mockImplementation(
      async (options: { run: () => Promise<unknown>; runWithOptions: { signal: AbortSignal } }) => {
        const running = options.run();
        const aborted = new Promise<never>((_resolve, reject) => {
          options.runWithOptions.signal.addEventListener(
            "abort",
            () => {
              const error = new Error("Stopped by user (Ctrl+C)");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        });
        queueMicrotask(() => requestRunAbort("Stopped by user (Ctrl+C)"));
        return Promise.race([running, aborted]);
      },
    );

    const logSystemEvent = vi.fn();
    await runEvilJellyHost({ logSystemEvent } as unknown as EvilJellyHostBindings, {
      model: { id: "test-model" } as ModelAdapter,
      sessionId: "idle-session",
      sessionV2: { enabled: true, appVersion: "1.0.0", sessionsRoot: "/sessions" },
    });

    expect(endSegment).toHaveBeenCalledOnce();
    expect(endSegment).toHaveBeenCalledWith({
      status: "interrupted",
      reason: "abort",
    });
    expect(close).toHaveBeenCalledOnce();
    expect(endSegment.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]!);
    expect(logSystemEvent).toHaveBeenCalledWith("\nRun interrupted by user.\n");
  });
});
