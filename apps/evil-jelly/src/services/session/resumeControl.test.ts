import { afterEach, describe, expect, it } from "vitest";
import {
  requestExit,
  requestNewSession,
  requestResume,
  takePendingExit,
  takePendingNewSession,
  takePendingResume,
} from "./resumeControl";

afterEach(() => {
  takePendingResume();
  takePendingNewSession();
  takePendingExit();
});

describe("session switch control", () => {
  it("queues a resume target once", () => {
    requestResume("session-1");

    expect(takePendingResume()).toBe("session-1");
    expect(takePendingResume()).toBeNull();
    expect(takePendingNewSession()).toBe(false);
  });

  it("queues a new session once", () => {
    requestNewSession();

    expect(takePendingNewSession()).toBe(true);
    expect(takePendingNewSession()).toBe(false);
    expect(takePendingResume()).toBeNull();
  });

  it("keeps resume and new-session requests mutually exclusive", () => {
    requestResume("old-session");
    requestNewSession();

    expect(takePendingResume()).toBeNull();
    expect(takePendingNewSession()).toBe(true);

    requestNewSession();
    requestResume("new-session");

    expect(takePendingNewSession()).toBe(false);
    expect(takePendingResume()).toBe("new-session");
  });

  it("queues an exit request once", () => {
    requestExit();

    expect(takePendingExit()).toBe(true);
    expect(takePendingExit()).toBe(false);
    expect(takePendingResume()).toBeNull();
    expect(takePendingNewSession()).toBe(false);
  });

  it("keeps exit mutually exclusive with session switches", () => {
    requestResume("old-session");
    requestExit();

    expect(takePendingResume()).toBeNull();
    expect(takePendingExit()).toBe(true);

    requestExit();
    requestNewSession();

    expect(takePendingExit()).toBe(false);
    expect(takePendingNewSession()).toBe(true);
  });
});
