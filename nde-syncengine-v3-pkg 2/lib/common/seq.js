'use strict';
/**
 * Shared low-level helpers reused by every feature's storage slice.
 *
 * PERF NOTES (balanced: throughput + latency + memory):
 *  - seqBatch: allocate sequence numbers in batches via INCRBY to cut Redis
 *    round-trips on hot conversations (1 RTT per N messages instead of per 1).
 *  - appendLog: single XADD with MAXLEN ~ approximate trim (no exact trim scan).
 *  - frame builders are cached buffers where the frame is static.
 */

/**
 * Allocate the next sequence for a conversation. On hot paths the caller can
 * request a batch; we hand out from a local window and only hit Redis when the
 * window is exhausted. This is process-local; safe because seq only needs to be
 * monotonic per conversation and a single gateway owns a conversation's writes
 * at a time via sticky routing. Falls back to plain INCR if no batcher given.
 */
async function nextSeq(redis, convId, batcher) {
  if (!batcher) return redis.incr(`conv:${convId}:seq`);
  return batcher.next(convId);
}

/**
 * SeqBatcher: amortizes Redis INCRBY across many sends on the same conversation.
 * window=1 disables batching (exact-per-message). Tune window upward for very
 * hot conversations; on gateway shutdown unused numbers are simply skipped
 * (gaps are allowed — clients never assume contiguity, only monotonicity).
 */
class SeqBatcher {
  constructor(redis, window = 16) {
    this.redis = redis;
    this.window = window;
    this.state = new Map(); // convId -> { current, max }
  }
  async next(convId) {
    let st = this.state.get(convId);
    if (!st || st.current >= st.max) {
      const top = await this.redis.incrby(`conv:${convId}:seq`, this.window);
      st = { current: top - this.window, max: top };
      this.state.set(convId, st);
    }
    return ++st.current;
  }
  /** Drop cached window for a conversation (e.g. on losing ownership). */
  evict(convId) { this.state.delete(convId); }
}

/** Append one entry to the durable per-conversation replay stream. */
function appendLog(redis, convId, fields) {
  return redis.xadd(`conv:${convId}:log`, 'MAXLEN', '~', '10000', '*', ...fields);
}

module.exports = { nextSeq, SeqBatcher, appendLog };
