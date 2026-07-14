/**
 * Multi-Model Agent Types
 */

import { z } from "zod";

/**
 * Agent input props
 */
export interface MultiModelAgentProps {
  /** User's question about the media */
  question: string;
  /** Image URL or Base64 data URL */
  imageUrl?: string;
  /** Video URL */
  videoUrl?: string;
  /** Additional context */
  context?: string;
}

/**
 * Agent output schema
 */
export const MultiModelResponseSchema = z.object({
  /** Answer to the user's question */
  answer: z.string().describe("Detailed answer to the user's question"),
  /** Key observations from the media */
  observations: z
    .array(z.string())
    .describe("Key observations or findings from analyzing the media"),
  /** Confidence level (0-1) */
  confidence: z.number().min(0).max(1).describe("Confidence level of the answer"),
  /** Whether the media was successfully analyzed */
  analysisSuccess: z.boolean().describe("Whether the media analysis was successful"),
  /** Additional insights */
  insights: z.string().optional().describe("Additional insights or recommendations"),
});

export type MultiModelResponse = z.infer<typeof MultiModelResponseSchema>;
