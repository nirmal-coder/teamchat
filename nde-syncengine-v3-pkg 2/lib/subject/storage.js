'use strict';
/** FEATURE: Group subject/description — storage slice. */
const { nextSeq } = require('../common/seq');
class SubjectStore {
  // Task 0.5: added convs for write-through persistence
  constructor({ col, convs, redis, batcher }) { this.col = col; this.convs = convs; this.redis = redis; this.batcher = batcher; }
  async set({ convId, by, field, value, ts, ulid }) {
    const seq = await nextSeq(this.redis, convId, this.batcher);
    await this.col.insertOne({ _id: ulid, convId, seq, senderId: by, contentType: 7 /*SYSTEM*/,
      system: { op: field === 'subject' ? 10 : 11, value }, ts, status: 1 });
    await this.redis.set(`conv:${convId}:${field}`, value);
    await this.convs.updateOne({ _id: convId }, { $set: { [field]: value } }, { upsert: true });
    return { seq };
  }
}
module.exports = { SubjectStore };
