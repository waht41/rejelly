import { describe, expect, it } from "vitest";
import { executeShellCommand, getShellEnvironmentSummary } from "./executeShellCommand";

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

  it("preserves literal newlines inside one Windows command argument", async () => {
    if (process.platform !== "win32") {
      return;
    }
    const value = "## Summary\n\n- First line\n- Second line";
    const command = `${makeNodeCommand(
      "process.stdout.write(JSON.stringify(process.argv[1]));",
    )} "${value}"`;

    const result = await executeShellCommand({ command, cwd: process.cwd() });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toBe(value);
  });

  it("streams stdout/stderr chunks through onData", async () => {
    const chunks: string[] = [];
    const result = await executeShellCommand(
      {
        command: makeNodeCommand("process.stdout.write('hello'); process.stderr.write('world');"),
        cwd: process.cwd(),
      },
      (data) => {
        chunks.push(data);
      },
    );

    expect(result.exitCode).toBe(0);
    const streamed = chunks.join("");
    expect(streamed).toContain("hello");
    expect(streamed).toContain("world");
  });

  it("strips ANSI sequences from captured output but streams them raw", async () => {
    const chunks: string[] = [];
    const result = await executeShellCommand(
      {
        command: makeNodeCommand(
          "const ESC=String.fromCharCode(27); process.stdout.write(ESC+'[1m'+ESC+'[32mgreen'+ESC+'[39m'+ESC+'[22m plain');",
        ),
        cwd: process.cwd(),
      },
      (data) => {
        chunks.push(data);
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("green plain");
    expect(result.output).not.toContain("\x1b[");
    expect(chunks.join("")).toContain("\x1b[32m");
  });

  it("returns non-zero exit code for failed command", async () => {
    const result = await executeShellCommand({
      command: makeNodeCommand("process.stderr.write('boom'); process.exit(7);"),
      cwd: process.cwd(),
    });
    expect(result.exitCode).toBe(7);
    expect(result.output).toContain("boom");
  });

  it("falls back to GB18030 for Windows command output that is not valid UTF-8", async () => {
    if (process.platform !== "win32") {
      return;
    }
    const chunks: string[] = [];
    const result = await executeShellCommand(
      {
        command: makeNodeCommand(
          "process.stdout.write(Buffer.from([0xc7,0xfd,0xb6,0xaf,0xc6,0xf7]));",
        ),
        cwd: process.cwd(),
      },
      (data) => {
        chunks.push(data);
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("驱动器");
    expect(chunks.join("")).toContain("驱动器");
  });

  it("does not lock Windows output to UTF-8 when only the first chunk is valid UTF-8", async () => {
    if (process.platform !== "win32") {
      return;
    }
    const bytes = Buffer.from([0xc2, 0xa1, 0xc7, 0xfd, 0xb6, 0xaf, 0xc6, 0xf7]);
    const expected = new TextDecoder("gb18030").decode(bytes);
    const chunks: string[] = [];
    const result = await executeShellCommand(
      {
        command: makeNodeCommand(
          "process.stdout.write(Buffer.from([0xc2,0xa1])); setTimeout(() => process.stdout.end(Buffer.from([0xc7,0xfd,0xb6,0xaf,0xc6,0xf7])), 20);",
        ),
        cwd: process.cwd(),
      },
      (data) => {
        chunks.push(data);
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(expected);
    expect(chunks.join("")).toContain(expected);
  });

  it("locks live Windows output to GB18030 as soon as UTF-8 is impossible", async () => {
    if (process.platform !== "win32") {
      return;
    }
    let sawGbBeforeTail = false;
    let sawTail = false;
    const result = await executeShellCommand(
      {
        command: makeNodeCommand(
          "process.stdout.write(Buffer.from([0xc7,0xfd,0xb6,0xaf,0xc6,0xf7])); setTimeout(() => process.stdout.end('tail'), 100);",
        ),
        cwd: process.cwd(),
      },
      (data) => {
        if (data.includes("驱动器") && !data.includes("tail") && !sawTail) {
          sawGbBeforeTail = true;
        }
        if (data.includes("tail")) {
          sawTail = true;
        }
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("驱动器tail");
    expect(sawGbBeforeTail).toBe(true);
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
