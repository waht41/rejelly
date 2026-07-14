/**
 * Normalized trace dual-write handlers (Norm* prefix — parallel to legacy handlers).
 */
export { NormAggregatedSpanHandler } from "./NormAggregatedSpanHandler";
export { NormGenerationHandler } from "./NormGenerationHandler";
export { NormStructuralHandler } from "./NormStructuralHandler";
export { NormUpdateLogHandler } from "./NormUpdateLogHandler";
export {
  attachDetailToHost,
  copyTraceEvent,
  findHostNodeIdForDetail,
  linkWaterfallOrphans,
  mergeEventIntoWaterfall,
  rebuildStructuralTopology,
  resolveStructuralParentId,
} from "./normShared";
