/**
 * Lua scripts for Redis rate limit store (token bucket / concurrency).
 * Use redis.eval(script, ...); for Cluster, rely on client's per-node script handling (e.g. defineCommand).
 */

/** Sentinel for "physical limit exceeded" so Node maps to Infinity / 413. */
export const LUA_RETRY_INFINITY = 999999999999;

/**
 * CONSUME: uses redis.call('TIME') for now (ms) to avoid NTP drift across clients.
 * ARGV: [1] preDeduct, [2] requestId, [3] timeoutMs;
 * then per rule (3 slots each): type, limit, windowMs (concurrency uses 0 for windowMs).
 * Returns Lua table as Redis array: {1} = success; {0, reason, retryMs?, failedRuleIndex} = rejected (index 1-based).
 */
export const CONSUME_SCRIPT = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local preDeduct = tonumber(ARGV[1])
local requestId = ARGV[2]
local timeoutMs = tonumber(ARGV[3])

local bucketCache = {}
local numRules = #KEYS

-- Phase 1: validate all (no writes)
for i = 1, numRules do
  local key = KEYS[i]
  local baseIdx = 3 + (i - 1) * 3
  local rType = ARGV[baseIdx + 1]
  local rLimit = tonumber(ARGV[baseIdx + 2])
  local rWindowMs = tonumber(ARGV[baseIdx + 3])

  if rType == 'concurrency' then
    redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
    local current_concurrency = redis.call('ZCARD', key)
    if current_concurrency >= rLimit then
      return { 0, 'concurrency', 0, i }
    end

  elseif rType == 'token' or rType == 'request' then
    local deductAmount = preDeduct
    if rType == 'request' then deductAmount = 1 end

    if rType == 'token' and preDeduct > rLimit then
      return { 0, 'token', 999999999999, i }
    end

    local bucket = redis.call('HMGET', key, 'tokens', 'last_refill')
    local tokens = tonumber(bucket[1]) or rLimit
    local last_refill = tonumber(bucket[2]) or now
    local elapsed = math.max(0, now - last_refill)
    local refill_rate = rLimit / rWindowMs
    local refilled_tokens = math.min(rLimit, tokens + (elapsed * refill_rate))
    bucketCache[i] = refilled_tokens

    if refilled_tokens < deductAmount then
      local needed = deductAmount - refilled_tokens
      local waitMs = math.ceil(needed / refill_rate)
      return { 0, rType, waitMs, i }
    end
  end
end

-- Phase 2: commit
for i = 1, numRules do
  local key = KEYS[i]
  local baseIdx = 3 + (i - 1) * 3
  local rType = ARGV[baseIdx + 1]
  local rWindowMs = tonumber(ARGV[baseIdx + 3])

  if rType == 'concurrency' then
    redis.call('ZADD', key, now + timeoutMs, requestId)
    redis.call('PEXPIRE', key, timeoutMs)

  elseif rType == 'token' then
    local remaining = bucketCache[i] - preDeduct
    redis.call('HSET', key, 'tokens', remaining, 'last_refill', now)
    redis.call('PEXPIRE', key, rWindowMs)

  elseif rType == 'request' then
    local remaining = bucketCache[i] - 1
    redis.call('HSET', key, 'tokens', remaining, 'last_refill', now)
    redis.call('PEXPIRE', key, rWindowMs)
  end
end

return { 1 }
`;

export const ADJUST_SCRIPT = `
local current = redis.call('HGET', KEYS[1], 'tokens')
if not current then return end
local adjustAmount = tonumber(ARGV[1])
local maxLimit = tonumber(ARGV[2])
local windowMs = tonumber(ARGV[3])
local newVal = math.min(maxLimit, tonumber(current) - adjustAmount)
redis.call('HSET', KEYS[1], 'tokens', newVal)
redis.call('PEXPIRE', KEYS[1], windowMs)
`;

/**
 * Renew concurrency lease: if the requestId still exists in each ZSET, update score and key TTL.
 * Uses Redis TIME to avoid NTP drift across clients.
 * KEYS: concurrency ZSET keys
 * ARGV[1]: requestId
 * ARGV[2]: timeoutMs (lease extension)
 */
export const RENEW_CONCURRENCY_SCRIPT = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local requestId = ARGV[1]
local timeoutMs = tonumber(ARGV[2])
local updated = 0

for i, key in ipairs(KEYS) do
  local score = redis.call('ZSCORE', key, requestId)
  if score then
    redis.call('ZADD', key, now + timeoutMs, requestId)
    redis.call('PEXPIRE', key, timeoutMs)
    updated = updated + 1
  end
end

return updated
`;

/**
 * Release concurrency: remove requestId from all given ZSET keys.
 * KEYS: concurrency ZSET keys
 * ARGV[1]: requestId
 */
export const RELEASE_CONCURRENCY_SCRIPT = `
local requestId = ARGV[1]
for i = 1, #KEYS do
  redis.call('ZREM', KEYS[i], requestId)
end
return 1
`;
