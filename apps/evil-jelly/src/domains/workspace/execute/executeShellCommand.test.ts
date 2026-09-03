import { describe, expect, it } from "vitest";
import { executeShellCommand, getShellEnvironmentSummary } from "./executeShellCommand";
import {
  combineCapturedShellOutput,
  decodeShellOutput,
  ShellOutputStreamDecoder,
} from "./shellOutput";

function makeNodeCommand(jsCode: string): string {
  if (process.platform === "win32") {
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    return `& ${quote(process.execPath)} -e ${quote(jsCode)}`;
  }
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(jsCode)}`;
}

describe("executeShellCommand", () => {
  it("reports the host shell environment for command result headers", () => {
    const summary = getShellEnvironmentSummary();
    expect(summary).toContain(process.platform);
    expect(summary).toContain("shell=");
    if (process.platform === "win32") {
      expect(summary).toContain("powershell.exe");
    }
  });

  it("runs through the host shell, preserves arguments, and streams both output channels", async () => {
    const value = "## Summary\n\n- First line\n- Second line";
    const chunks: string[] = [];
    const command = `${makeNodeCommand("const ESC=String.fromCharCode(27); process.stdout.write(JSON.stringify(process.argv[1])+'\\n'+ESC+'[32mgreen'+ESC+'[39m plain'); process.stderr.write('world');")} "${value}"`;

    const result = await executeShellCommand({ command, cwd: process.cwd() }, (data) => {
      chunks.push(data);
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output.split("\n")[0]!)).toBe(value);
    expect(result.output).toContain("green plain");
    expect(result.output).not.toContain("\x1b[");
    expect(result.output).toContain("world");
    const streamed = chunks.join("");
    expect(streamed).toContain(JSON.stringify(value));
    expect(streamed).toContain("\x1b[32m");
    expect(streamed).toContain("world");
  });

  it("strips terminal control sequences from captured output", () => {
    const captured = combineCapturedShellOutput(
      Buffer.from("\x1b[1m\x1b[32mgreen\x1b[39m\x1b[22m plain"),
      Buffer.from("world"),
    );

    expect(captured).toBe("green plain\nworld");
  });

  it("returns non-zero exit code for failed command", async () => {
    const result = await executeShellCommand({
      command: makeNodeCommand("process.stderr.write('boom'); process.exit(7);"),
      cwd: process.cwd(),
    });
    expect(result.exitCode).toBe(7);
    expect(result.output).toContain("boom");
  });

  it("falls back to GB18030 for captured Windows output that is not valid UTF-8", () => {
    const bytes = Buffer.from([0xc7, 0xfd, 0xb6, 0xaf, 0xc6, 0xf7]);

    expect(decodeShellOutput(bytes, true)).toBe("驱动器");
  });

  it("does not lock streaming Windows output to UTF-8 from one valid prefix", () => {
    const bytes = Buffer.from([0xc2, 0xa1, 0xc7, 0xfd, 0xb6, 0xaf, 0xc6, 0xf7]);
    const expected = new TextDecoder("gb18030").decode(bytes);
    const decoder = new ShellOutputStreamDecoder(true);

    expect(decoder.write(bytes.subarray(0, 2))).toBe("");
    expect(decoder.write(bytes.subarray(2))).toBe(expected);
    expect(decoder.end()).toBe("");
  });

  it("locks streaming Windows output to GB18030 as soon as UTF-8 is impossible", () => {
    const decoder = new ShellOutputStreamDecoder(true);

    expect(decoder.write(Buffer.from([0xc7, 0xfd, 0xb6, 0xaf, 0xc6, 0xf7]))).toBe("驱动器");
    expect(decoder.write(Buffer.from("tail"))).toBe("tail");
    expect(decoder.end()).toBe("");
  });

  it("closes stdin so interactive commands receive EOF instead of hanging", async () => {
    const result = await executeShellCommand({
      command: makeNodeCommand(
        "process.stdin.resume(); process.stdin.once('end',()=>process.stdout.write('stdin-closed'));",
      ),
      cwd: process.cwd(),
      timeoutMs: 2_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("stdin-closed");
  });

  it("terminates a command when its hard timeout expires", async () => {
    const startedAt = Date.now();
    const result = await executeShellCommand({
      command: makeNodeCommand("setInterval(()=>{}, 1000);"),
      cwd: process.cwd(),
      timeoutMs: 100,
    });

    expect(result.error?.code).toBe("ETIMEDOUT");
    expect(result.error?.killed).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(2_500);
  });

  it("keeps already streamed output when aborted", async () => {
    const abortController = new AbortController();
    const resultPromise = executeShellCommand({
      command: makeNodeCommand(
        "let n=0; const timer=setInterval(()=>{process.stdout.write('tick-'+(++n)+'\\n'); if(n>=20){clearInterval(timer)}}, 40);",
      ),
      cwd: process.cwd(),
      signal: abortController.signal,
    });
    setTimeout(() => abortController.abort(new Error("test abort")), 350);
    const result = await resultPromise;

    expect(result.error?.code).toBe("EABORTED");
    expect(result.output).toContain("tick-");
  });
});
