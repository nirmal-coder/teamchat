'use strict';
/** FEATURE: Conversation timer — engine slice. */
const F = require('../common/frames');
const { requireMember } = require('../common/errors');
const { ConvTimerStore } = require('./storage');
class ConvTimerEngine {
  constructor({ storage }) { this.store = new ConvTimerStore(storage); this.s = storage; }
  async setConvTimer({ convId, by, seconds, ts }) {
    await requireMember(this.s, convId, by);
    const { seq } = await this.store.set({ convId, seconds });
    return { frame: F.timerSet(convId, seq, by, seconds, ts), seq };
  }
}
module.exports = { ConvTimerEngine };
