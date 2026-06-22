'use strict';
/** FEATURE: Disappearing messages — engine slice. */
const F = require('../common/frames');
const { DisappearingStore } = require('./storage');

class DisappearingEngine {
  constructor({ storage }) { this.store = new DisappearingStore(storage); }
  /** Sweep expired messages; returns EXPIRED frames to broadcast. */
  async sweep({ convId, now }) {
    const swept = await this.store.sweep(convId, now);
    return swept.map((x) => ({ frame: F.expired(convId, x.seq, x.ulid, now), seq: x.seq, ulid: x.ulid }));
  }
}
module.exports = { DisappearingEngine };
