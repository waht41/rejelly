import { describe, expect, it } from "vitest";
import { run } from "../process.js";

describe("async process runner", () => {
  it("captures child output for compact verification reporting", async () => {
    const result = await run(process.execPath, ["-e", "console.log('ready')"], process.cwd(), {
      output: "capture",
    });

    expect(result).toMatchObject({ cancelled: false, status: 0, timedOut: false });
    expect(result.output).toContain("ready");
  });

  it("terminates a timed-out child with a distinct exit status", async () => {
    const result = await run(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      process.cwd(),
      {
        output: "capture",
        timeoutMs: 100,
      },
    );

    expect(result).toMatchObject({ cancelled: false, status: 124, timedOut: true });
  });
});
