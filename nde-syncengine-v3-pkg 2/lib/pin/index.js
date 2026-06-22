'use strict';
/** FEATURE: Pinned messages — public surface. */
module.exports = {
  ...require('./engine'),   // PinEngine, PIN_MAX
  storage: require('./storage'),
  wire: require('./wire'),
};
