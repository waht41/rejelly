/**
 * Multi-Model Agent
 *
 * An agent that can analyze images, videos, and other multimodal content
 * and answer questions about them.
 */

import type { ContentPart } from "@rejelly/core";
import { createAgent, equipInstruction, equipSystem, promptAgent } from "@rejelly/core";
import { getModel } from "@shared/runtime-model";
import {
  type MultiModelAgentProps,
  type MultiModelResponse,
  MultiModelResponseSchema,
} from "./types";

const model = getModel();

/**
 * Build multimodal instruction content
 */
function buildMultimodalContent(props: MultiModelAgentProps): ContentPart[] {
  const parts: ContentPart[] = [];

  // Add question text
  parts.push({
    type: "text",
    text: props.question,
  });

  // Add image if provided
  if (props.imageUrl) {
    parts.push({
      type: "image",
      image: {
        url: props.imageUrl,
        detail: "high", // Use high detail for better analysis
      },
    });
  }

  // Add video if provided
  if (props.videoUrl) {
    parts.push({
      type: "video",
      video: {
        url: props.videoUrl,
      },
    });
  }

  // Add context if provided
  if (props.context) {
    parts.push({
      type: "text",
      text: `\n\nAdditional context: ${props.context}`,
    });
  }

  return parts;
}

/**
 * Multi-Model Agent
 */
export const MultiModelAgent = createAgent<MultiModelAgentProps, MultiModelResponse>({
  id: "multi_model_agent",
  model,

  handler: async (props) => {
    // ============ Equipment Phase ============

    equipSystem(`You are an expert multimodal AI assistant capable of analyzing images, videos, and other media content.
Your capabilities include:
- Visual analysis: Identifying objects, scenes, text, people, and activities in images
- Video understanding: Analyzing video content, understanding temporal sequences, and extracting key moments
- Contextual reasoning: Understanding relationships between visual elements and answering questions
- Detailed observation: Noticing subtle details and providing comprehensive analysis

When analyzing media:
1. Carefully examine all visual elements
2. Identify key objects, people, scenes, and activities
3. Understand the context and relationships
4. Answer questions accurately based on what you observe
5. Provide detailed observations and insights
6. Indicate your confidence level honestly`);

    // Build multimodal instruction with images/videos
    const multimodalContent = buildMultimodalContent(props);
    equipInstruction(multimodalContent);

    // ============ Execution Phase ============

    const response = await promptAgent(MultiModelResponseSchema);

    return response;
  },
});
