'use strict';
/** FEATURE: Subject — wire. SUBJECT c->s [37, ulid, convId, field, value] */
const F = require('../common/frames');
function register(dispatch) {
  dispatch[F.T.SUBJECT] = async (gw, s, [, ulid, convId, field, value]) => {
    const { frame } = await gw.engine.setSubject({ convId, by: s.userId, field, value, ts: Date.now(), ulid });
    await gw.fanout.publish(convId, frame);
  };
}
module.exports = { register };
