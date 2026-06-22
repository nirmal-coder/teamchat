'use strict';
/** FEATURE: View-once media — storage slice (consume exactly once). */
const { nextSeq } = require('../common/seq');

class ViewOnceStore {
  constructor({ col, redis, batcher }) { this.col = col; this.redis = redis; this.batcher = batcher; }
  /** Mark viewed by userId; clears payload after first view. Returns states. */
  async consume({ targetUlid, convId, userId }) {
    const doc = await this.col.findOne({ _id: targetUlid, convId });
    if (!doc) return null;
    if (doc.contentType !== 9 /*VIEW_ONCE*/) return { notViewOnce: true };
    if ((doc.viewedBy || []).includes(userId)) return { already: true };
    const seq = await nextSeq(this.redis, convId, this.batcher);
    await this.col.updateOne({ _id: targetUlid, convId }, { $push: { viewedBy: userId }, $set: { viewSeq: seq } });
    await this.col.updateOne({ _id: targetUlid, convId }, { $unset: { payload: '' } });
    return { seq, firstView: true };
  }
}
module.exports = { ViewOnceStore };
