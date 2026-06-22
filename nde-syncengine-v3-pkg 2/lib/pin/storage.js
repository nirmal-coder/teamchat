'use strict';
/**
 * FEATURE: Pinned messages (WhatsApp: max 3 per chat).
 * Storage slice — owns the pin set + per-message pin flag.
 */
const { nextSeq } = require('../common/seq');

const PIN_MAX = 3;

class PinStore {
  // Task 0.4: added convs for write-through persistence
  constructor({ col, convs, redis, batcher }) { this.col = col; this.convs = convs; this.redis = redis; this.batcher = batcher; }

  async count(convId) {
    return (await this.redis.smembers(`conv:${convId}:pins`)).length;
  }
  async isPinned(convId, ulid) {
    return (await this.redis.sismember(`conv:${convId}:pins`, ulid)) === 1;
  }
  /** Pin/unpin a known-good target. Returns { seq }. */
  async setPin({ convId, targetUlid, on }) {
    const seq = await nextSeq(this.redis, convId, this.batcher);
    if (on) {
      await this.redis.sadd(`conv:${convId}:pins`, targetUlid);
      await this.convs.updateOne({ _id: convId }, { $addToSet: { pins: targetUlid } }, { upsert: true });
    } else {
      await this.redis.srem(`conv:${convId}:pins`, targetUlid);
      await this.convs.updateOne({ _id: convId }, { $pull: { pins: targetUlid } });
    }
    await this.col.updateOne({ _id: targetUlid, convId }, { $set: { pinned: on, pinSeq: seq } });
    return { seq };
  }
}

module.exports = { PinStore, PIN_MAX };
