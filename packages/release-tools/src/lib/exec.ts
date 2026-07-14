import type { ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { execFileSync } from "node:child_process";

type ExecOptions = Omit<ExecFileSyncOptionsWithStringEncoding, "encoding"> & {
  encoding?: BufferEncoding;
  ignoreErrors?: boolean;
};

export function exec(command: string, args: string[], options: ExecOptions = {}) {
  const commandWithArgs = resolveCommand(command, args);

  return execFileSync(commandWithArgs.command, commandWithArgs.args, {
    cwd: options.cwd,
    encoding: options.encoding ?? "utf8",
    input: options.input,
    stdio: options.stdio ?? ["ignore", "pipe", options.ignoreErrors ? "ignore" : "pipe"],
  });
}

function resolveCommand(command: string, args: string[]) {
  if (process.platform === "win32" && command === "pnpm") {
    return {
      args: ["/d", "/s", "/c", "pnpm", ...args],
      command: "cmd.exe",
    };
  }

  return { args, command };
}
