import type { Turn } from "./model";

const TURN_PREFIX = {
  user: "u",
  system: "s",
  assistant: "a",
  assistant_stream: "as",
  tool_round: "tr",
  tool: "t",
  diff: "d",
  banner: "b",
} satisfies Record<Turn["type"], string>;

/** Session-local display identities shared by live tool rows and committed history. */
export class HistorySequence {
  private turnId = 0;
  private toolOrdinal = 0;

  nextTurnId(type: Turn["type"]): string {
    return `${TURN_PREFIX[type]}_${this.turnId++}`;
  }

  nextToolOrdinal(): number {
    return ++this.toolOrdinal;
  }

  /** `/clear` starts a new addressable tool list but preserves globally unique turn ids. */
  resetToolOrdinals(): void {
    this.toolOrdinal = 0;
  }

  reset(): void {
    this.turnId = 0;
    this.toolOrdinal = 0;
  }
}
