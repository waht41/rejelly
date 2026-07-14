/**
 * Rule definition: key per rule so one request can be bounded by multiple keys
 * (e.g. tenant global concurrency + per-model RPM). Rules are pure boundaries, no redundant fields.
 */

// 1. Concurrency rule: no windowMs
export interface ConcurrencyRule {
  type: "concurrency";
  key: string;
  limit: number;
}

// 2. Request rate rule: windowMs required
export interface RequestRule {
  type: "request";
  key: string;
  limit: number;
  windowMs: number;
}

// 3. Token rate rule: windowMs required; rule only defines the boundary, no defaultPreDeduct
export interface TokenRule {
  type: "token";
  key: string;
  limit: number;
  windowMs: number;
}

export type RateLimitRule = ConcurrencyRule | RequestRule | TokenRule;

export type RateLimitType = RateLimitRule["type"];
