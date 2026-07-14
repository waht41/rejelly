import { z } from "zod";

export interface TraceToolContext {
  traceId?: string | null;
  defaultTraceDescription?: string | null;
}

export type TraceToolContextInput = TraceToolContext | string | null | undefined;

export function normalizeTraceToolContext(input?: TraceToolContextInput): TraceToolContext {
  if (typeof input === "string") {
    return { traceId: input, defaultTraceDescription: "the configured trace" };
  }
  if (input == null) return {};
  return input;
}

export function describeDefaultTrace(context: TraceToolContext): string {
  const description = context.defaultTraceDescription?.trim();
  if (description) return description;
  return context.traceId ? "the configured trace" : "the current trace context";
}

export function createTraceIdParameter(context: TraceToolContext, action: string) {
  return z
    .string()
    .optional()
    .describe(`Trace ID. Omit when ${action} ${describeDefaultTrace(context)}.`);
}

export function traceDefaultSentence(context: TraceToolContext): string {
  return `If traceId is omitted, uses ${describeDefaultTrace(context)}.`;
}

export function unavailableTraceMessage(action: string, context: TraceToolContext): string {
  return `${action} unavailable: no traceId was provided and ${describeDefaultTrace(
    context,
  )} is not available.`;
}
