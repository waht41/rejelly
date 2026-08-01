/** Shared contract for named stream-event channels on internal side-turns. */

/**
 * Stream-event channel tag on the context-compaction summarization side-turn.
 *
 * Producer and consumers sit in layers that cannot import each other, and both need the exact
 * string: the policy tags its side-turn with it, while stream consumers match on it to keep the
 * summary out of the reply — and to label the wait, since compaction is a full model round trip
 * with nothing on screen behind it.
 */
export const COMPACTION_STREAM_CHANNEL = "compaction";
