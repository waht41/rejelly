import { describe, expect, it, vi } from "vitest";
import { createInteractiveRunControl } from "./runControl";

describe("interactive run control", () => {
  it("routes aborts only while a segment handler is registered", () => {
    const control = createInteractiveRunControl();
    const abort = vi.fn();

    expect(control.segment.requestAbort("before")).toBe(false);
    const unregister = control.segment.registerAbort(abort);
    expect(control.segment.requestAbort("during")).toBe(true);
    expect(abort).toHaveBeenCalledWith("during");
    unregister();
    expect(control.segment.requestAbort("after")).toBe(false);
  });

  it("stores one mutually exclusive loop intent and consumes it once", () => {
    const control = createInteractiveRunControl();

    control.loop.request({ type: "resume", sessionId: "old" });
    control.loop.request({ type: "new_session" });

    expect(control.loop.take()).toEqual({ type: "new_session" });
    expect(control.loop.take()).toEqual({ type: "none" });
  });

  it("keeps separate instances isolated", () => {
    const first = createInteractiveRunControl();
    const second = createInteractiveRunControl();

    first.loop.request({ type: "exit" });

    expect(second.loop.take()).toEqual({ type: "none" });
    expect(first.loop.take()).toEqual({ type: "exit" });
  });
});
