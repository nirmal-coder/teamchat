'use strict';
/**
 * Composer. Assembles the core spine + every feature slice into:
 *   - SyncEngine: core methods + each feature engine's methods, on one object
 *   - CoreStore:  shared persistence base (features attach their own stores)
 *   - buildDispatch(): the gateway's frame-type -> handler table
 *
 * To add a feature: drop a folder under lib/<name>/ exporting { <Name>Engine,
 * wire.register }, then add it to FEATURES below. Nothing else changes.
 */
const { CoreEngine } = require('./core/engine');
const { CoreStore } = require('./core/storage');

const FEATURES = [
  require('./pin'),
  require('./poll'),
  require('./viewonce'),
  require('./disappearing'),
  require('./convtimer'),
  require('./subject'),
  require('./portability'),
];

/** Build a SyncEngine whose prototype carries core + every feature method. */
function makeEngine({ storage }) {
  const engine = new CoreEngine({ storage });
  for (const feat of FEATURES) {
    // each feature exports exactly one <Name>Engine class
    const EngineClass = Object.values(feat).find((v) => typeof v === 'function' && /Engine$/.test(v.name));
    if (!EngineClass) continue;
    const inst = new EngineClass({ storage });
    // copy the feature's own methods onto the core engine facade
    for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(inst))) {
      if (name === 'constructor') continue;
      engine[name] = inst[name].bind(inst);
    }
  }
  return engine;
}

/** Build the dispatch table the gateway consults per inbound frame. */
function buildDispatch() {
  const dispatch = {};
  for (const feat of FEATURES) if (feat.wire && feat.wire.register) feat.wire.register(dispatch);
  return dispatch;
}

module.exports = { makeEngine, buildDispatch, CoreStore, FEATURES };
