'use strict';
/** FEATURE: Disappearing messages — storage slice (server-side expiry sweep). */
const { nextSeq } = require('../common/seq');

class DisappearingStore {
  constructor({ col, redis, batcher, updateCachedDoc }) {
    this.col = col; this.redis = redis; this.batcher = batcher;
    this.updateCachedDoc = updateCachedDoc || null;
  }
  /** Tombstone messages whose ttl elapsed (ts + ttl*1000 <= now). Idempotent. */
  async sweep(convId, now) {
    const live = await this.col.find({ convId, ttl: { $gt: 0 } }).toArray();
    const swept = [];
    for (const d of live) {
      if (d.deleted || d.expired) continue;
      if (d.ts + d.ttl * 1000 > now) continue;
      const seq = await nextSeq(this.redis, convId, this.batcher);
      await this.col.updateOne({ _id: d._id, convId }, { $set: { expired: true, expireSeq: seq }, $unset: { payload: '' } });
      // Update cache so replay sends EXPIRED tombstone, not the original MSG
      if (this.updateCachedDoc) {
        await this.updateCachedDoc(convId, d._id, { expired: true, expireSeq: seq }, ['payload']);
      }
      swept.push({ ulid: d._id, seq });
    }
    return swept;
  }
}
module.exports = { DisappearingStore };
