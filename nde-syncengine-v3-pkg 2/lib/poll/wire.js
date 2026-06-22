'use strict';
/**
 * FEATURE: Polls — wire slice.
 *   POLL c->s [28, ulid, convId, question, options[], multi]
 *   VOTE c->s [30, ulid, convId, pollUlid, optionIdxs[]]   empty = retract
 */
const F = require('../common/frames');

function register(dispatch) {
  dispatch[F.T.POLL] = async (gw, s, [, ulid, convId, question, options, multi]) => {
    const { frame, seq } = await gw.engine.createPoll({ ulid, convId, senderId: s.userId, question, options, multi: !!multi, ts: Date.now() });
    await gw.fanout.publish(convId, frame);
    await gw.queueOffline(convId, seq, frame, s.userId);
  };
  dispatch[F.T.VOTE] = async (gw, s, [, , convId, pollUlid, optionIdxs]) => {
    const { frame } = await gw.engine.vote({ pollUlid, convId, userId: s.userId, optionIdxs: optionIdxs || [], ts: Date.now() });
    await gw.fanout.publish(convId, frame);
  };
}

module.exports = { register };
