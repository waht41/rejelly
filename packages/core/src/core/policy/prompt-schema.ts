import type { z } from "zod";
import { createJsonOutputParser } from "../engine/parse";
import { createAgentPolicy, type PromptContext } from "./prompt";
import { runToolCallLoopPolicy, transferJsonSchema } from "./tool-call-loop-policy";

export const STRUCTURE_POLICY_ID = "standard-structure";

export const promptAgent = createAgentPolicy({
  policyId: STRUCTURE_POLICY_ID,
  handler: async (ctx: PromptContext, schema: z.ZodTypeAny): Promise<unknown> => {
    const jsonSchema = transferJsonSchema(schema);
    ctx.span.setAttribute("schema", jsonSchema);

    const result = await runToolCallLoopPolicy(ctx, {
      jsonSchema,
      parser: createJsonOutputParser(schema),
    });

    return result.data;
  },
}) as <T extends z.ZodTypeAny>(schema: T) => Promise<z.infer<T>>;
