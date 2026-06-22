'use strict';
/** FEATURE: Polls — storage slice (server-authoritative vote tally). */
const { nextSeq } = require('../common/seq');

class PollStore {
  constructor({ col, redis, batcher }) { this.col = col; this.redis = redis; this.batcher = batcher; }

  async create({ ulid, convId, senderId, question, options, multi, ts }) {
    const seq = await nextSeq(this.redis, convId, this.batcher);
    await this.col.insertOne({ _id: ulid, convId, seq, senderId, contentType: 8 /*POLL*/,
      poll: { question, options, multi: !!multi, votes: {} }, ts, status: 1 });
    return { seq };
  }

  /** Cast/replace/retract a vote; recompute tally. Returns {seq,tally,voters} | null | {invalid}. */
  async vote({ pollUlid, convId, userId, optionIdxs, ts }) {
    const doc = await this.col.findOne({ _id: pollUlid, convId });
    if (!doc || !doc.poll) return null;
    const nOpts = doc.poll.options.length;
    for (const i of optionIdxs) if (i < 0 || i >= nOpts) return { invalid: true };
    if (!doc.poll.multi && optionIdxs.length > 1) return { invalid: true };

    const seq = await nextSeq(this.redis, convId, this.batcher);
    // Task 0.7: single findOneAndUpdate replaces updateOne + findOne (2 RTT → 1 RTT)
    const voteUpdate = optionIdxs.length
      ? { $set: { [`poll.votes.${userId}`]: optionIdxs } }
      : { $unset: { [`poll.votes.${userId}`]: '' } };
    const fresh = await this.col.findOneAndUpdate(
      { _id: pollUlid, convId },
      voteUpdate,
      { returnDocument: 'after' },
    );
    if (!fresh) return null;
    const tally = new Array(nOpts).fill(0);
    for (const picks of Object.values(fresh.poll.votes)) for (const i of picks) tally[i]++;
    return { seq, tally, voters: Object.keys(fresh.poll.votes).length };
  }
}

module.exports = { PollStore };
