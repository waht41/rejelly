import { describe, expect, it } from "vitest";
import { extractSlashQuery, filterSlashCommands, SLASH_COMMANDS } from "./slashCommands";

describe("extractSlashQuery", () => {
  it("returns the command token being typed at the caret", () => {
    expect(extractSlashQuery("/", 1)).toBe("");
    expect(extractSlashQuery("/res", 4)).toBe("res");
    expect(extractSlashQuery("/resume", 7)).toBe("resume");
  });

  it("requires the slash to start the line", () => {
    expect(extractSlashQuery("hello /resume", 13)).toBeNull();
    expect(extractSlashQuery(" /resume", 8)).toBeNull();
  });

  it("closes once the user types whitespace (moves to arguments)", () => {
    expect(extractSlashQuery("/resume ", 8)).toBeNull();
    expect(extractSlashQuery("/resume abc", 11)).toBeNull();
  });

  it("is inactive when the caret sits mid-token", () => {
    expect(extractSlashQuery("/resume", 3)).toBeNull();
  });
});

describe("filterSlashCommands", () => {
  it("lists all commands for an empty query", () => {
    expect(filterSlashCommands("")).toEqual(SLASH_COMMANDS);
  });

  it("matches on the command name without the slash", () => {
    expect(filterSlashCommands("res").map((c) => c.name)).toEqual(["/resume", "/compress"]);
    expect(filterSlashCommands("e").map((c) => c.name)).toEqual([
      "/resume",
      "/memory",
      "/clear",
      "/compress",
      "/mode",
      "/expand-tool",
      "/exit",
    ]);
    expect(filterSlashCommands("copy").map((c) => c.name)).toEqual(["/copy-last"]);
    expect(filterSlashCommands("clear").map((c) => c.name)).toEqual(["/clear"]);
    expect(filterSlashCommands("comp").map((c) => c.name)).toEqual(["/compress"]);
  });

  it("returns nothing when no command matches", () => {
    expect(filterSlashCommands("zzz")).toEqual([]);
  });
});
