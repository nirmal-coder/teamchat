'use strict';
/** FEATURE: View-once media — engine slice. */
const F = require('../common/frames');
const { ensure, requireMember } = require('../common/errors');
const { ViewOnceStore } = require('./storage');

class ViewOnceEngine {
  constructor({ storage }) { this.store = new ViewOnceStore(storage); this.s = storage; }
  async viewOnce({ convId, targetUlid, userId, ts }) {
    await requireMember(this.s, convId, userId);
    const r = await this.store.consume({ targetUlid, convId, userId });
    ensure(r, F.E.NOT_FOUND, 'message not found');
    ensure(!r.notViewOnce, F.E.BAD_FRAME, 'not a view-once message');
    ensure(!r.already, F.E.ALREADY_VIEWED, 'view-once already consumed');
    return { frame: F.viewed(convId, r.seq, targetUlid, userId, ts), seq: r.seq };
  }
}
module.exports = { ViewOnceEngine };
