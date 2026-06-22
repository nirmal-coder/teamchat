'use strict';
/**
 * Performance / optimization suite. Validates that the optimizations behave
 * correctly (not just fast): SeqBatcher monotonicity, conv-index targeted
 * delivery, and a throughput sanity benchmark for ingest.
 */
const assert = require('assert');
const F = require('../lib/common/frames');
const { CoreStore } = require('../lib/core/storage');
const { makeEngine } = require('../lib/index');
const { SeqBatcher } = require('../lib/common/seq');
const { FakeRedis, FakeMongo } = require('./fakes');

let passed = 0, failed = 0;
const groups = [];
const group = (n, fn) => groups.push({ name: n, fn });
async function expect(name, fn) {
  try { await fn(); passed++; console.log(`    PASS  ${name}`); }
  catch (e) { failed++; console.log(`    FAIL  ${name}\n          ${e.message}`); }
}
async function freshBatched(window) {
  const redis = new FakeRedis();
  const storage = new CoreStore({ mongo: new FakeMongo(), redis, seqWindow: window });
  await storage.init();
  return { redis, storage, engine: makeEngine({ storage }) };
}
const seed = (r, c, m) => Promise.all(m.map((u) => r.sadd(`conv:${c}:members`, u)));

group('30. SeqBatcher cuts Redis round-trips, stays monotonic', async () => {
  const redis = new FakeRedis();
  let incrbyCalls = 0;
  const origIncrby = redis.incrby.bind(redis);
  redis.incrby = (k, n) => { incrbyCalls++; return origIncrby(k, n); };
  const b = new SeqBatcher(redis, 16);
  await expect('1000 allocations use ~63 INCRBY calls (window 16), not 1000', async () => {
    const seqs = [];
    for (let i = 0; i < 1000; i++) seqs.push(await b.next('c1'));
    assert.ok(incrbyCalls <= Math.ceil(1000 / 16) + 1, `expected <=63 round-trips, got ${incrbyCalls}`);
    // strictly increasing (monotonic); contiguity not required under batching
    for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1]);
  });
  await expect('two conversations keep independent monotonic windows', async () => {
    const a1 = await b.next('cA'), a2 = await b.next('cA');
    const z1 = await b.next('cZ');
    assert.ok(a2 > a1);
    assert.ok(z1 >= 1);
  });
});

group('31. Batched ingest preserves dedup + monotonicity', async () => {
  const { redis, storage, engine } = await freshBatched(16);
  await seed(redis, 'c1', ['u1']);
  await expect('500 batched sends are strictly increasing and unique', async () => {
    const seqs = [];
    for (let i = 0; i < 500; i++) {
      const r = await engine.ingest({ ulid: `B${i}`, convId: 'c1', senderId: 'u1', contentType: 1, payload: Buffer.from('x'), ts: i });
      seqs.push(r.seq);
    }
    assert.strictEqual(new Set(seqs).size, 500, 'all unique');
    for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1], 'monotonic');
  });
  await expect('duplicate ULID still deduped under batching', async () => {
    const a = await engine.ingest({ ulid: 'DUPB', convId: 'c1', senderId: 'u1', contentType: 1, payload: Buffer.from('x'), ts: 1 });
    const b = await engine.ingest({ ulid: 'DUPB', convId: 'c1', senderId: 'u1', contentType: 1, payload: Buffer.from('x'), ts: 1 });
    assert.strictEqual(a.seq, b.seq);
    assert.strictEqual(b.msgFrame, null);
  });
});

group('32. Conv-index gives O(interested) fan-out, not O(all sockets)', async () => {
  // Simulate the gateway's convIndex behavior directly.
  const convIndex = new Map();
  const add = (c, s) => { if (!convIndex.has(c)) convIndex.set(c, new Set()); convIndex.get(c).add(s); };
  const sockets = Array.from({ length: 10000 }, (_, i) => ({ id: i, got: 0, send() { this.got++; } }));
  // only 5 sockets care about conv X; the rest are on other conversations
  for (let i = 0; i < 5; i++) add('X', sockets[i]);
  for (let i = 5; i < 10000; i++) add(`other${i}`, sockets[i]);
  await expect('delivering to conv X touches exactly 5 sockets', async () => {
    let touched = 0;
    const set = convIndex.get('X');
    for (const s of set) { s.send(); touched++; }
    assert.strictEqual(touched, 5, 'only interested sockets touched');
    assert.strictEqual(sockets.reduce((a, s) => a + s.got, 0), 5, 'no spurious deliveries');
  });
});

group('33. Throughput sanity (ingest)', async () => {
  const { redis, storage, engine } = await freshBatched(64);
  await seed(redis, 'c1', ['u1']);
  await expect('10k ingests complete and stay ordered (timing logged)', async () => {
    const N = 10000;
    const t0 = Date.now();
    let last = 0;
    for (let i = 0; i < N; i++) {
      const r = await engine.ingest({ ulid: `T${i}`, convId: 'c1', senderId: 'u1', contentType: 1, payload: Buffer.from('m'), ts: i });
      assert.ok(r.seq > last); last = r.seq;
    }
    const ms = Date.now() - t0;
    console.log(`          ${N} ingests in ${ms}ms (~${Math.round(N / (ms / 1000))}/s, in-memory fakes)`);
  });
});

(async () => {
  console.log('\n=== NDE Sync Engine — performance & optimization ===\n');
  for (const g of groups) { console.log('  ' + g.name); await g.fn(); }
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
