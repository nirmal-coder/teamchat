'use strict';
/** FEATURE: Disappearing — wire. No inbound frame; driven by a periodic sweep job. */
function register(/* dispatch */) { /* server-initiated, see startSweeper() */ }
/** Helper a gateway/cron can call per active conversation. */
async function runSweep(gw, convId, now = Date.now()) {
  const events = await gw.engine.sweep({ convId, now });
  for (const e of events) await gw.fanout.publish(convId, e.frame);
  return events.length;
}
module.exports = { register, runSweep };
