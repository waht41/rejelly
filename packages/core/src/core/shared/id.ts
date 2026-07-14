import { generateHexBytes } from "../../utils/crypto-random";

/**
 * Generate trace ID (32 hex chars, no hyphens)
 * Required for OTLP/Jaeger
 */
export function generateTraceId(): string {
  return generateHexBytes(16);
}

/**
 * Generate span ID (16 hex chars)
 */
export function generateSpanId(): string {
  return generateHexBytes(8);
}
