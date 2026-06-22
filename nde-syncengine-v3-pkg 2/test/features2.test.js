'use strict';
/**
 * Round-2 feature suite — WhatsApp engine features added after the parity audit.
 * Positive + negative cases for: pinned messages, polls/voting, view-once media,
 * server-side disappearing-message expiry sweep, per-conversation timer,
 * group subject/description, and multi-device receipt aggregation.
 *
 * Reuses the real Storage + SyncEngine against in-memory fakes.
 */
const assert = require('assert');
const F = require('../lib/common/frames');
const { Storage } = require('../lib/compat');
const { SyncEngine, PIN_MAX } = require('../lib/compat');
const { FakeRedis, FakeMongo } = require('./fakes');

let passed = 0, failed = 0;
const groups = [];
function group(name, fn) { groups.push({ name, fn }); }
async function expect(name, fn) {
  try { await fn(); passed++; console.log(`    PASS  ${name}`); }
  catch (e) { failed++; console.log(`    FAIL  ${name}\n          ${e.message}`); }
}
async function rejects(fn, code) {
  try { await fn(); throw new Error('expected rejection but resolved'); }
  catch (e) {
    if (e.message === 'expected rejection but resolved') throw e;
    if (code !== undefined && e.code !== code) throw new Error(`expected code ${code}, got ${e.code} (${e.message})`);
  }
}
function sink(redis) { const out = []; return { redis, out, send: (b) => out.push(F.decode(b)) }; }
async function fresh() {
  const redis = new FakeRedis();
  const storage = new Storage({ mongo: new FakeMongo(), redis });
  await storage.init();
  return { redis, storage, engine: new SyncEngine({ storage }) };
}
async function seedGroup(redis, convId, members, admins = []) {
  for (const m of members) await redis.sadd(`conv:${convId}:members`, m);
  for (const a of admins) await redis.sadd(`conv:${convId}:admins`, a);
}
const U = (id) => `user${id}`;
const text = (s) => Buffer.from(s);

// ---------------------------------------------------------------------------

group('16. Pinned messages (max 3 per chat)', async () => {
  const { redis, engine } = await fresh();
  await seedGroup(redis, 'g1', [U(1), U(2)], [U(1)]);
  for (const u of ['M1', 'M2', 'M3', 'M4']) {
    await engine.ingest({ ulid: u, convId: 'g1', senderId: U(1), contentType: 1, payload: text(u), ts: 1 });
  }
  await expect('member pins a message -> PINNED frame on=1', async () => {
    const r = await engine.pin({ convId: 'g1', targetUlid: 'M1', by: U(2), on: true, ts: 10 });
    const d = F.decode(r.frame);
    assert.strictEqual(d[0], F.T.PINNED);
    assert.strictEqual(d[3], 'M1');
    assert.strictEqual(d[5], 1, 'on flag');
  });
  await expect('pin up to the max of 3', async () => {
    await engine.pin({ convId: 'g1', targetUlid: 'M2', by: U(1), on: true, ts: 11 });
    await engine.pin({ convId: 'g1', targetUlid: 'M3', by: U(1), on: true, ts: 12 });
    assert.strictEqual(PIN_MAX, 3);
  });
  await expect('NEGATIVE: 4th pin rejected (PIN_LIMIT)', async () => {
    await rejects(() => engine.pin({ convId: 'g1', targetUlid: 'M4', by: U(1), on: true, ts: 13 }), F.E.PIN_LIMIT);
  });
  await expect('unpin frees a slot, then 4th pin succeeds', async () => {
    const off = F.decode((await engine.pin({ convId: 'g1', targetUlid: 'M1', by: U(1), on: false, ts: 14 })).frame);
    assert.strictEqual(off[5], 0, 'off flag');
    const r = await engine.pin({ convId: 'g1', targetUlid: 'M4', by: U(1), on: true, ts: 15 });
    assert.ok(r.seq);
  });
  await expect('NEGATIVE: non-member cannot pin (NOT_MEMBER)', async () => {
    await rejects(() => engine.pin({ convId: 'g1', targetUlid: 'M2', by: U(9), on: true, ts: 16 }), F.E.NOT_MEMBER);
  });
  await expect('NEGATIVE: pin nonexistent message (NOT_FOUND)', async () => {
    await rejects(() => engine.pin({ convId: 'g1', targetUlid: 'NOPE', by: U(1), on: true, ts: 17 }), F.E.NOT_FOUND);
  });
});

group('17. Polls + server-side vote tallying', async () => {
  const { redis, engine } = await fresh();
  await seedGroup(redis, 'g1', [U(1), U(2), U(3)]);
  await expect('create poll -> POLL_CREATED with options', async () => {
    const r = await engine.createPoll({ ulid: 'P1', convId: 'g1', senderId: U(1),
      question: 'Lunch?', options: ['Idli', 'Dosa', 'Pongal'], multi: false, ts: 1 });
    const d = F.decode(r.frame);
    assert.strictEqual(d[0], F.T.POLL_CREATED);
    assert.deepStrictEqual(d[6], ['Idli', 'Dosa', 'Pongal']);
  });
  await expect('votes aggregate server-side', async () => {
    await engine.vote({ pollUlid: 'P1', convId: 'g1', userId: U(1), optionIdxs: [1], ts: 2 });
    await engine.vote({ pollUlid: 'P1', convId: 'g1', userId: U(2), optionIdxs: [1], ts: 3 });
    const r = await engine.vote({ pollUlid: 'P1', convId: 'g1', userId: U(3), optionIdxs: [0], ts: 4 });
    assert.deepStrictEqual(r.tally, [1, 2, 0]);
    const d = F.decode(r.frame);
    assert.strictEqual(d[4][1], 2, 'Dosa has 2 votes');
    assert.strictEqual(d[5], 3, 'three voters');
  });
  await expect('changing a vote replaces prior selection (single-choice)', async () => {
    const r = await engine.vote({ pollUlid: 'P1', convId: 'g1', userId: U(1), optionIdxs: [0], ts: 5 });
    assert.deepStrictEqual(r.tally, [2, 1, 0], 'U1 moved Dosa->Idli');
  });
  await expect('retract vote (empty selection) removes the voter', async () => {
    const r = await engine.vote({ pollUlid: 'P1', convId: 'g1', userId: U(2), optionIdxs: [], ts: 6 });
    assert.deepStrictEqual(r.tally, [2, 0, 0]);
    assert.strictEqual(r.frame ? F.decode(r.frame)[5] : null, 2, 'two voters remain');
  });
  await expect('NEGATIVE: vote invalid option index (BAD_POLL)', async () => {
    await rejects(() => engine.vote({ pollUlid: 'P1', convId: 'g1', userId: U(1), optionIdxs: [9], ts: 7 }), F.E.BAD_POLL);
  });
  await expect('NEGATIVE: single-choice poll rejects multi-select (BAD_POLL)', async () => {
    await rejects(() => engine.vote({ pollUlid: 'P1', convId: 'g1', userId: U(1), optionIdxs: [0, 1], ts: 8 }), F.E.BAD_POLL);
  });
  await expect('NEGATIVE: poll with <2 options rejected (BAD_POLL)', async () => {
    await rejects(() => engine.createPoll({ ulid: 'P2', convId: 'g1', senderId: U(1),
      question: 'x', options: ['only'], multi: false, ts: 9 }), F.E.BAD_POLL);
  });
  await expect('NEGATIVE: vote on nonexistent poll (NOT_FOUND)', async () => {
    await rejects(() => engine.vote({ pollUlid: 'GHOST', convId: 'g1', userId: U(1), optionIdxs: [0], ts: 10 }), F.E.NOT_FOUND);
  });
  await expect('NEGATIVE: non-member cannot vote (NOT_MEMBER)', async () => {
    await rejects(() => engine.vote({ pollUlid: 'P1', convId: 'g1', userId: U(9), optionIdxs: [0], ts: 11 }), F.E.NOT_MEMBER);
  });
});

group('18. Multi-select polls', async () => {
  const { redis, engine } = await fresh();
  await seedGroup(redis, 'g1', [U(1), U(2)]);
  await engine.createPoll({ ulid: 'MP', convId: 'g1', senderId: U(1),
    question: 'Toppings?', options: ['Cheese', 'Onion', 'Chilli'], multi: true, ts: 1 });
  await expect('multi-select counts multiple options for one voter', async () => {
    const r = await engine.vote({ pollUlid: 'MP', convId: 'g1', userId: U(1), optionIdxs: [0, 2], ts: 2 });
    assert.deepStrictEqual(r.tally, [1, 0, 1]);
  });
});

group('19. View-once media (consume exactly once)', async () => {
  const { redis, storage, engine } = await fresh();
  await seedGroup(redis, 'd1', [U(1), U(2)]);
  // a view-once image (contentType 9)
  await engine.ingest({ ulid: 'V1', convId: 'd1', senderId: U(1), contentType: 9, payload: text('secret.jpg'), ts: 1 });
  await expect('first view -> VIEWED frame + payload cleared server-side', async () => {
    const r = await engine.viewOnce({ convId: 'd1', targetUlid: 'V1', userId: U(2), ts: 2 });
    const d = F.decode(r.frame);
    assert.strictEqual(d[0], F.T.VIEWED);
    assert.strictEqual(d[3], 'V1');
    const stored = await storage.getByUlid('V1');
    assert.strictEqual(stored.payload, undefined, 'payload purged after view');
  });
  await expect('NEGATIVE: second view rejected (ALREADY_VIEWED)', async () => {
    await rejects(() => engine.viewOnce({ convId: 'd1', targetUlid: 'V1', userId: U(2), ts: 3 }), F.E.ALREADY_VIEWED);
  });
  await expect('NEGATIVE: view-once on a normal message rejected (BAD_FRAME)', async () => {
    await engine.ingest({ ulid: 'N1', convId: 'd1', senderId: U(1), contentType: 1, payload: text('hi'), ts: 4 });
    await rejects(() => engine.viewOnce({ convId: 'd1', targetUlid: 'N1', userId: U(2), ts: 5 }), F.E.BAD_FRAME);
  });
  await expect('NEGATIVE: non-member cannot view (NOT_MEMBER)', async () => {
    await rejects(() => engine.viewOnce({ convId: 'd1', targetUlid: 'V1', userId: U(9), ts: 6 }), F.E.NOT_MEMBER);
  });
});

group('20. Disappearing messages: server-side expiry sweep', async () => {
  const { redis, storage, engine } = await fresh();
  await seedGroup(redis, 'c1', [U(1), U(2)]);
  // ttl in seconds; send at ts=1000 with 60s ttl
  await engine.ingest({ ulid: 'E1', convId: 'c1', senderId: U(1), contentType: 1, payload: text('boom'), ts: 1000, ttl: 60 });
  await engine.ingest({ ulid: 'E2', convId: 'c1', senderId: U(1), contentType: 1, payload: text('stay'), ts: 1000, ttl: 0 });
  await expect('not-yet-expired message is not swept', async () => {
    const swept = await engine.sweep({ convId: 'c1', now: 1000 + 30 * 1000 }); // 30s later
    assert.strictEqual(swept.length, 0);
  });
  await expect('expired message swept -> EXPIRED frame + payload cleared', async () => {
    const swept = await engine.sweep({ convId: 'c1', now: 1000 + 61 * 1000 }); // 61s later
    assert.strictEqual(swept.length, 1);
    const d = F.decode(swept[0].frame);
    assert.strictEqual(d[0], F.T.EXPIRED);
    assert.strictEqual(d[3], 'E1');
    const stored = await storage.getByUlid('E1');
    assert.strictEqual(stored.expired, true);
    assert.strictEqual(stored.payload, undefined);
  });
  await expect('message without ttl is never swept', async () => {
    const stored = await storage.getByUlid('E2');
    assert.ok(!stored.expired);
  });
  await expect('sweep is idempotent (already-expired not re-swept)', async () => {
    const swept = await engine.sweep({ convId: 'c1', now: 1000 + 120 * 1000 });
    assert.strictEqual(swept.length, 0);
  });
  await expect('expired message replays as EXPIRED tombstone on reconnect', async () => {
    const s = sink(redis);
    await engine._replay(s, 'c1', 0);
    const expiredFrame = s.out.find((f) => f[0] === F.T.EXPIRED && f[3] === 'E1');
    assert.ok(expiredFrame, 'EXPIRED tombstone present in replay');
    const liveE1 = s.out.find((f) => f[0] === F.T.MSG && f[2] === 'E1');
    assert.ok(!liveE1, 'expired message not replayed as live MSG');
  });
});

group('21. Per-conversation disappearing default timer', async () => {
  const { redis, storage, engine } = await fresh();
  await seedGroup(redis, 'g1', [U(1), U(2)], [U(1)]);
  await expect('admin sets conv timer -> TIMER_SET + persisted', async () => {
    const r = await engine.setConvTimer({ convId: 'g1', by: U(1), seconds: 86400, ts: 1 });
    const d = F.decode(r.frame);
    assert.strictEqual(d[0], F.T.TIMER_SET);
    assert.strictEqual(d[4], 86400);
    assert.strictEqual(await storage.getConvTimer('g1'), 86400);
  });
  await expect('NEGATIVE: non-member cannot set timer (NOT_MEMBER)', async () => {
    await rejects(() => engine.setConvTimer({ convId: 'g1', by: U(9), seconds: 100, ts: 2 }), F.E.NOT_MEMBER);
  });
});

group('22. Group subject / description (admin only)', async () => {
  const { redis, storage, engine } = await fresh();
  await seedGroup(redis, 'g1', [U(1), U(2)], [U(1)]);
  await expect('admin sets subject -> SUBJECT_SET + ordered system event', async () => {
    const r = await engine.setSubject({ convId: 'g1', by: U(1), field: 'subject', value: 'Team NDE', ts: 1, ulid: 'S1' });
    const d = F.decode(r.frame);
    assert.strictEqual(d[0], F.T.SUBJECT_SET);
    assert.strictEqual(d[5], 'Team NDE');
    assert.strictEqual(await redis.get('conv:g1:subject'), 'Team NDE');
  });
  await expect('admin sets description', async () => {
    const r = await engine.setSubject({ convId: 'g1', by: U(1), field: 'description', value: 'Build status', ts: 2, ulid: 'S2' });
    assert.strictEqual(F.decode(r.frame)[4], 'description');
  });
  await expect('NEGATIVE: non-admin cannot change subject (NOT_ADMIN)', async () => {
    await rejects(() => engine.setSubject({ convId: 'g1', by: U(2), field: 'subject', value: 'hijack', ts: 3, ulid: 'S3' }), F.E.NOT_ADMIN);
  });
  await expect('NEGATIVE: unknown metadata field rejected (BAD_FRAME)', async () => {
    await rejects(() => engine.setSubject({ convId: 'g1', by: U(1), field: 'color', value: 'red', ts: 4, ulid: 'S4' }), F.E.BAD_FRAME);
  });
  await expect('subject change appears as ordered system message on sync', async () => {
    const s = sink(redis);
    await engine._replay(s, 'g1', 0);
    const sys = s.out.filter((f) => f[0] === F.T.MSG && f[5] === 7 /*SYSTEM*/);
    assert.ok(sys.length >= 2, 'subject + description system messages in log');
  });
});

group('23. Multi-device receipt aggregation (per-user, not per-device)', async () => {
  const { redis, storage } = await fresh();
  await seedGroup(redis, 'g1', [U(1), U(2), U(3)]);
  // U2 has two devices; only one reads. U2 should count once as read.
  await expect('two devices of one user collapse to a single user read', async () => {
    await storage.setCursor('dev-2a', 'g1', 1, 5, U(2)); // delivered on phone
    await storage.setCursor('dev-2b', 'g1', 2, 5, U(2)); // read on laptop
    await storage.setCursor('dev-3a', 'g1', 1, 5, U(3)); // delivered on phone only
    const agg = await storage.receiptAgg('g1', 5);
    assert.strictEqual(agg.total, 3);
    assert.strictEqual(agg.read, 1, 'only U2 has read (on any device)');
    assert.strictEqual(agg.delivered, 2, 'U2 and U3 delivered');
  });
  await expect('a non-member cursor is ignored in aggregation', async () => {
    await storage.setCursor('dev-x', 'g1', 2, 5, U(99)); // not a member
    const agg = await storage.receiptAgg('g1', 5);
    assert.strictEqual(agg.read, 1, 'stranger does not inflate read count');
  });
});

group('24. TTL passthrough still carries to client meta', async () => {
  const { redis, engine } = await fresh();
  await seedGroup(redis, 'c1', [U(1)]);
  await expect('ingest with ttl -> MSG meta.ttl set and persisted', async () => {
    const r = await engine.ingest({ ulid: 'T1', convId: 'c1', senderId: U(1), contentType: 1, payload: text('poof'), ts: 1, ttl: 3600 });
    const d = F.decode(r.msgFrame);
    assert.strictEqual(d[8].ttl, 3600);
  });
});

// ---------------------------------------------------------------------------
(async () => {
  console.log('\n=== NDE Sync Engine — WhatsApp parity round 2 (new features) ===\n');
  for (const g of groups) { console.log('  ' + g.name); await g.fn(); }
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
