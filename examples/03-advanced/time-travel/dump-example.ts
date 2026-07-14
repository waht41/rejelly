/**
 * Dump snapshot example: run Agent (with bug) → on error call dumpSnapshot() → run fixed Agent
 * with runWith(..., { snapshot }). Second run replays cached LLM response, no extra tokens.
 *
 * See docs/api/time-travel.md for dumpSnapshot and runWith(snapshot).
 */

import {
  type AgentSnapshot,
  createAgent,
  equipInstruction,
  equipSystem,
  promptAgent,
  runWith,
} from "@rejelly/core";
import { dumpSnapshot } from "@rejelly/core/debugger";
import { getModel } from "@shared/runtime-model";
import { z } from "zod";

interface Props {
  query: string;
}

// Old and new Agent must use identical schema, model, prompt for contentHash replay.
const MathSchema = z.object({
  formula: z.string().describe("The math formula from user input"),
});

const AGENT_ID = "calculate_agent";
const SYSTEM_PROMPT =
  "You are a precise calculator Agent. Your task is to extract the exact math formula from the user's question.";

function wrongCalculate(formula: string): string {
  console.log(`[🔴 Wrong side] Calculating formula: ${formula}`);
  throw new Error("Invalid formula format, cannot parse the string");
}

function correctCalculate(formula: string): string {
  console.log(`[🟢 Fixed side] Calculating formula: ${formula}`);
  return "144";
}

let savedSnapshot: AgentSnapshot | undefined;
const model = getModel();

const wrongCalculateAgent = createAgent({
  id: AGENT_ID,
  model,
  handler: async ({ query }: Props) => {
    equipSystem(SYSTEM_PROMPT);
    equipInstruction(query);
    console.log(`[🔴 Old Agent] Requesting LLM to extract formula (will consume tokens)...`);
    const result = await promptAgent(MathSchema);
    console.log(`[🔴 Old Agent] LLM extracted:`, result.formula);
    try {
      return wrongCalculate(result.formula);
    } catch (e) {
      console.error(`[🔴 Old Agent] Caught calculation error, dumping snapshot...`);
      savedSnapshot = dumpSnapshot();
      throw e;
    }
  },
});

const correctCalculateAgent = createAgent({
  id: AGENT_ID,
  model,
  handler: async ({ query }: Props) => {
    equipSystem(SYSTEM_PROMPT);
    equipInstruction(query);
    console.log(`[🟢 New Agent] Requesting LLM (instant if snapshot injected, no tokens)...`);
    const result = await promptAgent(MathSchema);
    console.log(`[🟢 New Agent] Extracted:`, result.formula);
    return correctCalculate(result.formula);
  },
});

async function main() {
  const testQuery = "What is 12 times 12";

  console.log("========== Part 1: Run old Agent (expect error) ==========");
  try {
    await runWith(async () => wrongCalculateAgent({ query: testQuery }), { enableSnapshot: true });
  } catch (e: unknown) {
    console.log(`[Main] Old Agent failed: ${(e as Error).message}`);
  }

  if (!savedSnapshot) {
    console.error("❌ Snapshot extraction failed, aborting.");
    return;
  }
  console.log("\n✅ Snapshot saved (includes LLM conversation cache)");

  console.log("\n========== Part 2: Run new Agent with snapshot injection ==========");
  const correctResult = await runWith(async () => correctCalculateAgent({ query: testQuery }), {
    snapshot: savedSnapshot,
  });
  console.log(`\n🎉 Final result: ${correctResult}`);
}

export { main as runDumpExample, wrongCalculateAgent, correctCalculateAgent };
