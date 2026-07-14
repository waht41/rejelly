/**
 * Utility functions for working with files
 */

import type { TraceEvent } from "@rejelly/core";

/**
 * Read a file and convert it to string
 * Supports text-based file formats (JSON, JSONL, etc.)
 *
 * @param file - The File object to read
 * @returns Promise that resolves to the file content as string
 * @throws Error if file reading fails
 */
export function readFileAsString(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        if (!content) {
          reject(new Error("File content is empty"));
          return;
        }
        resolve(content);
      } catch (error) {
        reject(new Error(`Failed to read file content: ${error}`));
      }
    };

    reader.onerror = () => {
      reject(new Error("Failed to read file"));
    };

    try {
      reader.readAsText(file);
    } catch (error) {
      reject(new Error(`Failed to start reading file: ${error}`));
    }
  });
}

/**
 * Parse trace events from a file
 * Supports JSON and JSONL formats
 *
 * @param file - The File object to parse
 * @returns Promise that resolves to an array of TraceEvent
 * @throws Error if file reading or parsing fails
 */
export async function parseTraceEventsFromFile(file: File): Promise<TraceEvent[]> {
  // Read file content as string
  const content = await readFileAsString(file);

  // Check if it's JSONL format (file extension or content pattern)
  const isJsonl = file.name.endsWith(".jsonl") || file.name.endsWith(".ndjson");
  let events: TraceEvent[] = [];

  if (isJsonl) {
    // Parse JSONL format: each line is a JSON object
    const lines = content.split("\n").filter((line) => line.trim());
    if (lines.length === 0) {
      throw new Error("No valid lines found in JSONL file");
    }

    events = [];
    for (let i = 0; i < lines.length; i++) {
      try {
        const lineParsed = JSON.parse(lines[i]);
        // If line is an array, flatten it
        if (Array.isArray(lineParsed)) {
          events.push(...lineParsed);
        } else {
          events.push(lineParsed);
        }
      } catch (lineError) {
        console.warn(`[FileUtils] Failed to parse line ${i + 1} in JSONL file:`, lineError);
        // Continue parsing other lines
      }
    }

    if (events.length === 0) {
      throw new Error("No valid events found in JSONL file");
    }
  } else {
    // Parse regular JSON format
    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch (_parseError) {
      throw new Error("Invalid JSON format");
    }

    // Check if it's a TraceEvent[] array or { events: [...] } format
    if (Array.isArray(parsed)) {
      // Direct array of events
      events = parsed;
    } else if (parsed.events && Array.isArray(parsed.events)) {
      // { events: [...] } format
      events = parsed.events;
    } else if (parsed.id && parsed.nodeMap && parsed.rootSpanIds) {
      // It's a processed Trace object, not events
      throw new Error(
        "This file contains a processed trace, not raw events. Please load a file containing TraceEvent[] array format.",
      );
    } else {
      throw new Error(
        "Invalid file format. Expected TraceEvent[] array or { events: [...] } format.",
      );
    }
  }

  if (events.length === 0) {
    throw new Error("No events found in file");
  }

  return events;
}

/**
 * Group trace events by traceId
 *
 * Useful when a file contains events from multiple traces.
 * Returns an array of { traceId, events } objects.
 *
 * @param events - Array of trace events
 * @returns Array of grouped traces
 */
export function groupEventsByTraceId(
  events: TraceEvent[],
): { traceId: string; events: TraceEvent[] }[] {
  const grouped = new Map<string, TraceEvent[]>();

  for (const event of events) {
    const traceId = event.trace.traceId;
    if (!grouped.has(traceId)) {
      grouped.set(traceId, []);
    }
    grouped.get(traceId)!.push(event);
  }

  // Convert Map to array format
  return Array.from(grouped.entries()).map(([traceId, events]) => ({
    traceId,
    events,
  }));
}
