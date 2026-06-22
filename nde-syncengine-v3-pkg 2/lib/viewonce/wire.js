'use strict';
/** FEATURE: View-once — wire. VIEW_ONCE c->s [32, ulid, convId, targetUlid] */
const F = require('../common/frames');
function register(dispatch) {
  dispatch[F.T.VIEW_ONCE] = async (gw, s, [, , convId, targetUlid]) => {
    const { frame } = await gw.engine.viewOnce({ convId, targetUlid, userId: s.userId, ts: Date.now() });
    await gw.fanout.publish(convId, frame);
  };
}
module.exports = { register };
