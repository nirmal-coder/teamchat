'use strict';
/**
 * FEATURE: Pinned messages — wire slice.
 * Frame contract:  PIN c->s [26, ulid, convId, targetUlid, on]  on:1 pin,0 unpin
 *                  PINNED s->c [27, convId, seq, targetUlid, by, on, ts]
 * Registers itself on the gateway dispatch table.
 */
const F = require('../common/frames');

function register(dispatch) {
  dispatch[F.T.PIN] = async (gw, s, [, , convId, targetUlid, on]) => {
    const { frame } = await gw.engine.pin({ convId, targetUlid, by: s.userId, on: !!on, ts: Date.now() });
    await gw.fanout.publish(convId, frame);
  };
}

module.exports = { register };
