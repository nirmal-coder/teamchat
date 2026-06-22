'use strict';
/**
 * Concurrency / load-correctness suite. Validates the invariants the 100K-user
 * design depends on: per-conversation sequence monotonicity, idempotency under
 * concurrent duplicate sends, and stable total order under interleaved writers.
 */
const assert = require('assert');
const F = require('../lib/common/frames');
const { Storage } = require('../lib/compat');
const { SyncEngine } = require('../lib/compat');
const { FakeRedis, FakeMongo } = require('./fakes');

let passed = 0, failed = 0;
const groups = [];
const group = (name, fn) => groups.push({ name, fn });
async function expect(name, fn) {
  try { await fn(); passed++; console.log(`    PASS  ${name}`); }
  catch (e) { failed++; console.log(`    FAIL  ${name}\n          ${e.message}`); }
}
async function fresh() {
  const redis = new FakeRedis();
  const storage = new Storage({ mongo: new FakeMongo(), redis });
  await storage.init();
  return { redis, storage, engine: new SyncEngine({ storage }) };
}
const seed = (redis, c, members) => Promise.all(members.map((m) => redis.sadd(`conv:${c}:members`, m)));

group('25. Sequence monotonicity under load', async () => {
  const { redis, storage, engine } = await fresh();
  await seed(redis, 'c1', ['u1']);
  await expect('1000 sequential sends produce strictly increasing, gapless seqs', async () => {
    const seqs = [];
    for (let i = 0; i < 1000; i++) {
      const r = await engine.ingest({ ulid: `M${i}`, convId: 'c1', senderId: 'u1', contentType: 1, payload: Buffer.from(String(i)), ts: i });
      seqs.push(r.seq);
    }
    for (let i = 1; i < seqs.length; i++) assert.strictEqual(seqs[i], seqs[i - 1] + 1, `gap at ${i}`);
    assert.strictEqual(seqs[0], 1);
    assert.strictEqual(seqs[seqs.length - 1], 1000);
  });
});

group('26. Idempotency under concurrent duplicate sends', async () => {
  const { redis, storage, engine } = await fresh();
  await seed(redis, 'c1', ['u1']);
  await expect('same ULID sent 50x concurrently allocates exactly one seq', async () => {
    const calls = Array.from({ length: 50 }, () =>
      engine.ingest({ ulid: 'DUP', convId: 'c1', senderId: 'u1', contentType: 1, payload: Buffer.from('x'), ts: 1 }));
    const results = await Promise.all(calls);
    const uniqueSeqs = new Set(results.map((r) => r.seq));
    assert.strictEqual(uniqueSeqs.size, 1, 'all resends map to one seq');
    const broadcasts = results.filter((r) => r.msgFrame !== null);
    assert.strictEqual(broadcasts.length, 1, 'exactly one broadcast, rest deduped');
  });
});

group('27. Interleaved writers keep per-conversation total order', async () => {
  const { redis, storage, engine } = await fresh();
  await seed(redis, 'c1', ['a', 'b', 'c']);
  await expect('three senders interleaved -> contiguous 1..30, no dup seq', async () => {
    const tasks = [];
    for (let i = 0; i < 30; i++) {
      const sender = ['a', 'b', 'c'][i % 3];
      tasks.push(engine.ingest({ ulid: `X${i}`, convId: 'c1', senderId: sender, contentType: 1, payload: Buffer.from(String(i)), ts: i }));
    }
    const results = await Promise.all(tasks);
    const seqs = results.map((r) => r.seq).sort((x, y) => x - y);
    assert.strictEqual(new Set(seqs).size, 30, 'no duplicate seq');
    for (let i = 0; i < 30; i++) assert.strictEqual(seqs[i], i + 1);
  });
});

group('28. Replay after load reconstructs exact ordered state', async () => {
  const { redis, storage, engine } = await fresh();
  await seed(redis, 'c1', ['u1']);
  for (let i = 0; i < 250; i++) {
    await engine.ingest({ ulid: `R${i}`, convId: 'c1', senderId: 'u1', contentType: 1, payload: Buffer.from(String(i)), ts: i });
  }
  await expect('replay from 0 returns all 250 in seq order', async () => {
    const out = [];
    const session = { redis, send: (b) => out.push(F.decode(b)) };
    await engine._replay(session, 'c1', 0);
    const msgs = out.filter((f) => f[0] === F.T.MSG);
    assert.strictEqual(msgs.length, 250);
    for (let i = 1; i < msgs.length; i++) assert.ok(msgs[i][2] > msgs[i - 1][2], 'seq strictly increasing in replay');
  });
  await expect('replay from mid-point returns only the tail', async () => {
    const out = [];
    const session = { redis, send: (b) => out.push(F.decode(b)) };
    await engine._replay(session, 'c1', 200);
    const msgs = out.filter((f) => f[0] === F.T.MSG);
    assert.strictEqual(msgs.length, 50, 'only seq 201..250');
    assert.strictEqual(msgs[0][2], 201);
  });
});

group('29. Mixed-operation load (send/edit/react/delete) stays ordered', async () => {
  const { redis, storage, engine } = await fresh();
  await seed(redis, 'c1', ['u1', 'u2']);
  await expect('100 mixed ops produce a monotonic control-seq stream', async () => {
    const seqs = [];
    for (let i = 0; i < 100; i++) {
      const u = `K${i}`;
      const r = await engine.ingest({ ulid: u, convId: 'c1', senderId: 'u1', contentType: 1, payload: Buffer.from('m'), ts: 1000 + i });
      seqs.push(r.seq);
      if (i % 3 === 0) seqs.push((await engine.react({ convId: 'c1', targetUlid: u, userId: 'u2', emoji: '👍', op: 1, ts: 1000 + i })).seq);
      if (i % 5 === 0) seqs.push((await engine.edit({ convId: 'c1', targetUlid: u, editorId: 'u1', newPayload: Buffer.from('m2'), ts: 1000 + i })).seq);
    }
    for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1], `control seq not increasing at ${i}: ${seqs[i]} <= ${seqs[i-1]}`);
  });
});

(async () => {
  console.log('\n=== NDE Sync Engine — concurrency & load correctness ===\n');
  for (const g of groups) { console.log('  ' + g.name); await g.fn(); }
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
