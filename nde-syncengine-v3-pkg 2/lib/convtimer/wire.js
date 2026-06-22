'use strict';
/** FEATURE: Conversation timer — wire. CONV_TIMER c->s [35, ulid, convId, seconds] */
const F = require('../common/frames');
function register(dispatch) {
  dispatch[F.T.CONV_TIMER] = async (gw, s, [, , convId, seconds]) => {
    const { frame } = await gw.engine.setConvTimer({ convId, by: s.userId, seconds: seconds || 0, ts: Date.now() });
    await gw.fanout.publish(convId, frame);
  };
}
module.exports = { register };
