/**
 * Outbound message queue for offline durability.
 *
 * Buffers SEND frames until ACK'd, replaying on WS reconnect.
 * Bounded by maxSize (drops oldest) and ttlMs (drops expired on drain).
 */

const DEFAULTS = {
  maxSize: 200,
  ttlMs: 24 * 60 * 60 * 1_000,   // 24 hours — dead-letter messages are dropped after this
}

export class OutQueue {
  constructor({ maxSize = DEFAULTS.maxSize, ttlMs = DEFAULTS.ttlMs } = {}) {
    this._q      = []
    this._maxSize = maxSize
    this._ttlMs  = ttlMs
  }

  push(ulid, buf, ts) {
    if (this._q.length >= this._maxSize) {
      // Drop the oldest un-ACK'd message to make room (prevents unbounded growth offline)
      console.warn('[OutQueue] at capacity, dropping oldest message')
      this._q.shift()
    }
    this._q.push({ ulid, buf, ts })
  }

  remove(ulid) {
    const i = this._q.findIndex(e => e.ulid === ulid)
    if (i !== -1) this._q.splice(i, 1)
  }

  get size() { return this._q.length }

  /**
   * Replay all live (non-expired) entries via sendFn.
   * Expired entries are pruned in-place before replay.
   */
  drain(sendFn) {
    const now = Date.now()
    this._q = this._q.filter(e => now - e.ts < this._ttlMs)
    for (const { buf } of this._q.slice()) {
      try { sendFn(buf) } catch {}
    }
  }

  clear() { this._q = [] }
}
