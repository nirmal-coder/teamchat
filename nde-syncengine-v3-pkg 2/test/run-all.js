'use strict';
// Runs every test suite in sequence and reports a grand total.
const { execSync } = require('child_process');
const suites = ['protocol.test.js', 'features.test.js', 'features2.test.js', 'concurrency.test.js', 'gateway.test.js', 'perf.test.js', 'portability.test.js', 'offline.test.js'];
let allPass = true;
for (const s of suites) {
  console.log(`\n########## ${s} ##########`);
  try { console.log(execSync(`node test/${s}`, { cwd: __dirname + '/..', encoding: 'utf8' })); }
  catch (e) { allPass = false; console.log(e.stdout || e.message); }
}
console.log(allPass ? '\nALL SUITES PASSED' : '\nSOME SUITES FAILED');
process.exit(allPass ? 0 : 1);
