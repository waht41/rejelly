/**
 * Merges trace events into NormalizedTrace.waterfall aggregated spans.
 */
import type { TraceEvent } from "@rejelly/core";
import type { EventHandler, TraceContext } from "../types";
import { mergeEventIntoWaterfall } from "./normShared";

export class NormAggregatedSpanHandler implements EventHandler {
  filter(_event: TraceEvent): boolean {
    return true;
  }

  handle(event: TraceEvent, ctx: TraceContext): void {
    mergeEventIntoWaterfall(ctx, event);
  }
}
