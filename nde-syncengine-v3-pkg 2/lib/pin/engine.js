'use strict';
/**
 * FEATURE: Pinned messages — engine slice (rules + broadcast frame).
 */
const F = require('../common/frames');
const { ensure, requireMember, requireTarget } = require('../common/errors');
const { PinStore, PIN_MAX } = require('./storage');

class PinEngine {
  constructor({ storage }) {
    this.store = new PinStore(storage);
    this.s = storage; // for shared guards (isMember, getByUlid)
  }
  /**
   * Pin or unpin a message. Members may pin; max PIN_MAX pinned per chat.
   * Existence is checked before the limit so a bad target reports NOT_FOUND.
   */
  async pin({ convId, targetUlid, by, on, ts }) {
    await requireMember(this.s, convId, by);
    await requireTarget(this.s, convId, targetUlid); // NOT_FOUND wins over PIN_LIMIT
    if (on && !(await this.store.isPinned(convId, targetUlid))) {
      ensure(await this.store.count(convId) < PIN_MAX, F.E.PIN_LIMIT, `max ${PIN_MAX} pinned messages`);
    }
    const { seq } = await this.store.setPin({ convId, targetUlid, on });
    return { frame: F.pinned(convId, seq, targetUlid, by, on ? 1 : 0, ts), seq };
  }
}

module.exports = { PinEngine, PIN_MAX };
