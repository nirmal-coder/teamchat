'use strict';
/** FEATURE: Per-conversation disappearing default timer — storage slice. */
const { nextSeq } = require('../common/seq');
class ConvTimerStore {
  // Task 0.5: added convs for write-through persistence
  constructor({ convs, redis, batcher }) { this.redis = redis; this.convs = convs; this.batcher = batcher; }
  async set({ convId, seconds }) {
    const seq = await nextSeq(this.redis, convId, this.batcher);
    await this.redis.set(`conv:${convId}:timer`, seconds);
    await this.convs.updateOne({ _id: convId }, { $set: { timer: seconds } }, { upsert: true });
    return { seq };
  }
  async get(convId) { return Number(await this.redis.get(`conv:${convId}:timer`)) || 0; }
}
module.exports = { ConvTimerStore };
