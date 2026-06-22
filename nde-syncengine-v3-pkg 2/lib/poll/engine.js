'use strict';
/** FEATURE: Polls — engine slice. */
const F = require('../common/frames');
const { ensure, requireMember } = require('../common/errors');
const { PollStore } = require('./storage');

class PollEngine {
  constructor({ storage }) { this.store = new PollStore(storage); this.s = storage; }

  async createPoll({ ulid, convId, senderId, question, options, multi, ts }) {
    await requireMember(this.s, convId, senderId);
    ensure(question && Array.isArray(options) && options.length >= 2 && options.length <= 12,
      F.E.BAD_POLL, 'poll needs a question and 2-12 options');
    const { seq } = await this.store.create({ ulid, convId, senderId, question, options, multi, ts });
    return { frame: F.pollCreated(convId, seq, ulid, senderId, question, options, multi ? 1 : 0, ts), seq };
  }

  async vote({ pollUlid, convId, userId, optionIdxs, ts }) {
    await requireMember(this.s, convId, userId);
    const r = await this.store.vote({ pollUlid, convId, userId, optionIdxs, ts });
    ensure(r, F.E.NOT_FOUND, 'poll not found');
    ensure(!r.invalid, F.E.BAD_POLL, 'invalid option(s) for this poll');
    return { frame: F.pollTally(convId, r.seq, pollUlid, r.tally, r.voters), seq: r.seq, tally: r.tally };
  }
}

module.exports = { PollEngine };
