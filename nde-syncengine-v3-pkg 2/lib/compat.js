'use strict';
/**
 * Back-compat shim so the existing test suite runs unchanged against the new
 * feature-folder lib. Tests use engine.* (provided by the composer) plus a few
 * direct storage.* reads. We expose exactly those.
 */
const { CoreStore } = require('./core/storage');
const { makeEngine } = require('./index');
const core = require('./core/engine');
const { EngineError } = require('./common/errors');
const { PIN_MAX } = require('./pin');
const { ConvTimerStore } = require('./convtimer/storage');

/** Storage = CoreStore + getConvTimer (the only feature read tests call directly). */
class Storage extends CoreStore {
  constructor(opts) {
    super(opts);
    this._timer = new ConvTimerStore(this.bundle());
  }
  getConvTimer(convId) { return this._timer.get(convId); }
}

function SyncEngine({ storage }) { return makeEngine({ storage }); }

module.exports = {
  Storage, SyncEngine, EngineError, PIN_MAX,
  LIVE_MAX: core.LIVE_MAX, EDIT_WINDOW_MS: core.EDIT_WINDOW_MS,
  DELETE_WINDOW_MS: core.DELETE_WINDOW_MS, FWD_LIMIT: core.FWD_LIMIT,
};
