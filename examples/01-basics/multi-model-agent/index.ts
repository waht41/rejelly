/**
 * Multi-Model Agent Example
 *
 * Demonstrates how to use the MultiModelAgent to analyze images and videos
 * and answer questions about them.
 */

import type { ExampleModule } from "@shared/types";
import { MultiModelAgent } from "./multi-model-agent";

export const meta = {
  name: "Multi-Model Agent",
  description: "Analyze images and videos with multi-modal model",
  order: 11,
};

export const examples = {
  "ask-image": {
    title: "Ask about image (with text)",
    description: "Ask specific questions about an image with text",
    run: async () => {
      console.log("🔍 Example 1: Asking specific questions about an image with text\n");
      const result = await MultiModelAgent({
        question: "What text is in this image? Please tell me all the text content in the image.",
        imageUrl: "https://images.unsplash.com/photo-1558655146-364adaf1fcc9?w=800",
      });
      console.log("✅ Answer:");
      console.log(result.answer);
      console.log(`\nConfidence: ${(result.confidence * 100).toFixed(1)}%`);
    },
  },
  "analyze-video": {
    title: "Analyze video",
    description: "Analyze a video and describe what happens",
    run: async () => {
      console.log("\n\n🎥 Example 2: Analyzing a video\n");
      const result = await MultiModelAgent({
        question: "What is the main content of this video? What happens in the video?",
        videoUrl:
          "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4",
        context: "This is a sample video",
      });
      console.log("✅ Analysis Result:");
      console.log(`Answer: ${result.answer}`);
      console.log(`\nObservations:`);
      result.observations.forEach((obs, i) => {
        console.log(`  ${i + 1}. ${obs}`);
      });
      console.log(`\nConfidence: ${(result.confidence * 100).toFixed(1)}%`);
    },
  },
  "analyze-base64-image": {
    title: "Analyze Base64 image",
    description: "Download image from network, convert to Base64 and analyze",
    run: async () => {
      console.log("\n\n🖼️  Example 3: Analyzing Base64 image (downloaded from network)\n");
      const imageUrl = "https://images.unsplash.com/photo-1518837695005-2083093ee35b?w=800";
      console.log(`Downloading image from: ${imageUrl}`);
      const response = await fetch(imageUrl);
      if (!response.ok) throw new Error(`Failed to download image: ${response.statusText}`);
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const base64 = buffer.toString("base64");
      const mimeType = response.headers.get("content-type") || "image/jpeg";
      const base64Image = `data:${mimeType};base64,${base64}`;
      console.log(
        `Image downloaded and converted to Base64 (${(buffer.length / 1024).toFixed(2)} KB)`,
      );
      const result = await MultiModelAgent({
        question: "What is in this image? Please describe in detail.",
        imageUrl: base64Image,
      });
      console.log("✅ Answer:");
      console.log(result.answer);
    },
  },
} satisfies ExampleModule["examples"];
