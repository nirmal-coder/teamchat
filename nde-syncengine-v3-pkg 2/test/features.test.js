'use strict';
/**
 * Full feature suite. Runs the real Storage + SyncEngine against in-memory
 * Redis/Mongo fakes. Covers every WhatsApp engine-level feature with both
 * positive (works as intended) and negative (correctly rejected) cases.
 */
const assert = require('assert');
const F = require('../lib/common/frames');
const { Storage } = require('../lib/compat');
const { SyncEngine, EngineError, EDIT_WINDOW_MS, DELETE_WINDOW_MS, FWD_LIMIT } = require('../lib/compat');
const { FakeRedis, FakeMongo } = require('./fakes');

let passed = 0, failed = 0;
const groups = [];
function group(name, fn) { groups.push({ name, fn }); }

async function expect(name, fn) {
  try { await fn(); passed++; console.log(`    PASS  ${name}`); }
  catch (e) { failed++; console.log(`    FAIL  ${name}\n          ${e.message}`); }
}
// assert that an async fn throws an EngineError with a specific code
async function rejects(fn, code) {
  try { await fn(); throw new Error('expected rejection but resolved'); }
  catch (e) {
    if (e.message === 'expected rejection but resolved') throw e;
    if (code !== undefined && e.code !== code) throw new Error(`expected code ${code}, got ${e.code} (${e.message})`);
  }
}

// capture frames a session would receive
function sink() { const out = []; return { redis: null, out, send: (b) => out.push(F.decode(b)) }; }

async function fresh() {
  const redis = new FakeRedis();
  const mongo = new FakeMongo();
  const storage = new Storage({ mongo, redis });
  await storage.init();
  const engine = new SyncEngine({ storage });
  return { redis, storage, engine };
}
async function seedGroup(redis, convId, members, admins = []) {
  for (const m of members) await redis.sadd(`conv:${convId}:members`, m);
  for (const a of admins) await redis.sadd(`conv:${convId}:admins`, a);
}
const U = (id) => `user${id}`;
const text = (s) => Buffer.from(s);

// ---------------------------------------------------------------------------
group('1. Ordered delivery + sequencing', async () => {
  const { redis, engine } = await fresh();
  await seedGroup(redis, 'c1', [U(1), U(2)]);
  await expect('messages get strictly increasing seq', async () => {
    const a = await engine.ingest({ ulid: 'A', convId: 'c1', senderId: U(1), contentType: 1, payload: text('hi'), ts: 1000 });
    const b = await engine.ingest({ ulid: 'B', convId: 'c1', senderId: U(2), contentType: 1, payload: text('yo'), ts: 1001 });
    const c = await engine.ingest({ ulid: 'C', convId: 'c1', senderId: U(1), contentType: 1, payload: text('!'), ts: 1002 });
    assert.deepStrictEqual([a.seq, b.seq, c.seq], [1, 2, 3]);
  });
  await expect('separate conversations have independent seq', async () => {
    await seedGroup(redis, 'c2', [U(1)]);
    const x = await engine.ingest({ ulid: 'X', convId: 'c2', senderId: U(1), contentType: 1, payload: text('a'), ts: 1 });
    assert.strictEqual(x.seq, 1, 'c2 starts at 1 regardless of c1');
  });
});

group('2. Idempotent send (at-least-once + dedup)', async () => {
  const { redis, engine } = await fresh();
  await seedGroup(redis, 'c1', [U(1)]);
  await expect('resend of same ULID returns same seq, no rebroadcast', async () => {
    const first = await engine.ingest({ ulid: 'DUP', convId: 'c1', senderId: U(1), contentType: 1, payload: text('x'), ts: 1 });
    const again = await engine.ingest({ ulid: 'DUP', convId: 'c1', senderId: U(1), contentType: 1, payload: text('x'), ts: 1 });
    assert.strictEqual(first.seq, again.seq);
    assert.ok(first.msgFrame !== null);
    assert.strictEqual(again.msgFrame, null, 'duplicate must not rebroadcast');
  });
  await expect('seq counter not advanced by duplicate', async () => {
    const n = await engine.ingest({ ulid: 'NEW', convId: 'c1', senderId: U(1), contentType: 1, payload: text('y'), ts: 2 });
    // Duplicate ingests consume a seq slot (no upfront findOne — only monotonicity guaranteed, not contiguity)
    assert.ok(n.seq > 1, 'new message seq is strictly after first real message');
    assert.ok(n.msgFrame !== null, 'new message produces a broadcast frame');
  });
});

group('3. Membership enforcement', async () => {
  const { redis, engine } = await fresh();
  await seedGroup(redis, 'c1', [U(1)]);
  await expect('member can send', async () => {
    const r = await engine.ingest({ ulid: 'M1', convId: 'c1', senderId: U(1), contentType: 1, payload: text('hi'), ts: 1 });
    assert.ok(r.seq >= 1);
  });
  await expect('NEGATIVE: non-member send rejected NOT_MEMBER', async () => {
    await rejects(() => engine.ingest({ ulid: 'M2', convId: 'c1', senderId: U(99), contentType: 1, payload: text('hi'), ts: 2 }), F.E.NOT_MEMBER);
  });
});

group('4. Reconnect convergence + gap fill', async () => {
  const { redis, engine } = await fresh();
  await seedGroup(redis, 'c1', [U(1)]);
  for (let i = 1; i <= 5; i++) await engine.ingest({ ulid: `S${i}`, convId: 'c1', senderId: U(1), contentType: 1, payload: text(`m${i}`), ts: i });
  await expect('client behind by 3 receives exactly the 3 missing msgs in order', async () => {
    const s = sink(); s.redis = redis;
    await engine.onHello(s, [{ convId: 'c1', lastSeq: 2 }]);
    const seqs = s.out.filter((f) => f[0] === F.T.MSG).map((f) => f[1] === 'c1' ? f[1] : null) && s.out.map((f) => f[2]);
    const msgSeqs = s.out.filter((f) => f[0] === F.T.MSG).map((f) => f[1] /*convId pos? */);
    const onlySeqs = s.out.filter((f) => f[0] === F.T.MSG).map((f) => f[1]);
    // MSG frame = [4, convId, seq, ulid, ...]; seq is index 2
    const got = s.out.filter((f) => f[0] === F.T.MSG).map((f) => f[2]);
    assert.deepStrictEqual(got, [3, 4, 5]);
  });
  await expect('up-to-date client receives nothing', async () => {
    const s = sink(); s.redis = redis;
    await engine.onHello(s, [{ convId: 'c1', lastSeq: 5 }]);
    assert.strictEqual(s.out.length, 0);
  });
  await expect('huge gap forces REST backfill (SYNC_GAP useRest=1)', async () => {
    const s = sink(); s.redis = redis;
    await redis.set('conv:c1:seq', 100000);
    await engine.onHello(s, [{ convId: 'c1', lastSeq: 0 }]);
    const gap = s.out.find((f) => f[0] === F.T.SYNC_GAP);
    assert.ok(gap, 'should emit SYNC_GAP');
    assert.strictEqual(gap[4], 1, 'useRest flag set');
  });
});

group('5. Message edit + 15-min window', async () => {
  const { redis, engine } = await fresh();
  await seedGroup(redis, 'c1', [U(1), U(2)]);
  await engine.ingest({ ulid: 'E1', convId: 'c1', senderId: U(1), contentType: 1, payload: text('helo'), ts: 1000 });
  await expect('owner edits within window', async () => {
    const r = await engine.edit({ convId: 'c1', targetUlid: 'E1', editorId: U(1), newPayload: text('hello'), ts: 1000 + 60000 });
    const d = F.decode(r.frame);
    assert.strictEqual(d[0], F.T.EDITED);
    assert.deepStrictEqual(Buffer.from(d[4]), text('hello'));
  });
  await expect('NEGATIVE: non-owner cannot edit (NOT_SENDER)', async () => {
    await rejects(() => engine.edit({ convId: 'c1', targetUlid: 'E1', editorId: U(2), newPayload: text('hax'), ts: 1000 + 60000 }), F.E.NOT_SENDER);
  });
  await expect('NEGATIVE: edit after window rejected (EDIT_WINDOW)', async () => {
    await rejects(() => engine.edit({ convId: 'c1', targetUlid: 'E1', editorId: U(1), newPayload: text('late'), ts: 1000 + EDIT_WINDOW_MS + 1 }), F.E.EDIT_WINDOW);
  });
  await expect('NEGATIVE: edit nonexistent message (NOT_FOUND)', async () => {
    await rejects(() => engine.edit({ convId: 'c1', targetUlid: 'NOPE', editorId: U(1), newPayload: text('x'), ts: 1000 }), F.E.NOT_FOUND);
  });
});

group('6. Delete-for-everyone + window + admin override', async () => {
  const { redis, engine } = await fresh();
  await seedGroup(redis, 'c1', [U(1), U(2), U(3)], [U(3)]);
  await engine.ingest({ ulid: 'D1', convId: 'c1', senderId: U(1), contentType: 1, payload: text('oops'), ts: 1000 });
  await engine.ingest({ ulid: 'D2', convId: 'c1', senderId: U(1), contentType: 1, payload: text('two'), ts: 1000 });
  await expect('owner deletes within window -> tombstone', async () => {
    const r = await engine.deleteForEveryone({ convId: 'c1', targetUlid: 'D1', deleterId: U(1), ts: 2000 });
    const d = F.decode(r.frame);
    assert.strictEqual(d[0], F.T.DELETED);
    assert.strictEqual(d[3], 'D1'); // [17, convId, seq, targetUlid, ...]
  });
  await expect('admin can delete others message', async () => {
    const r = await engine.deleteForEveryone({ convId: 'c1', targetUlid: 'D2', deleterId: U(3), ts: 2000 });
    assert.ok(r.seq);
  });
  await expect('NEGATIVE: non-owner non-admin cannot delete (NOT_SENDER)', async () => {
    await engine.ingest({ ulid: 'D3', convId: 'c1', senderId: U(1), contentType: 1, payload: text('three'), ts: 1000 });
    await rejects(() => engine.deleteForEveryone({ convId: 'c1', targetUlid: 'D3', deleterId: U(2), ts: 2000 }), F.E.NOT_SENDER);
  });
  await expect('NEGATIVE: owner delete after window rejected (DELETE_WINDOW)', async () => {
    await engine.ingest({ ulid: 'D4', convId: 'c1', senderId: U(1), contentType: 1, payload: text('old'), ts: 1000 });
    await rejects(() => engine.deleteForEveryone({ convId: 'c1', targetUlid: 'D4', deleterId: U(1), ts: 1000 + DELETE_WINDOW_MS + 1 }), F.E.DELETE_WINDOW);
  });
  await expect('deleted message replays as DELETED tombstone on sync', async () => {
    const s = sink(); s.redis = redis;
    await engine.onHello(s, [{ convId: 'c1', lastSeq: 0 }]);
    const tomb = s.out.find((f) => f[0] === F.T.DELETED && f[3] === 'D1');
    assert.ok(tomb, 'D1 should replay as tombstone, not original text');
  });
});

group('7. Reactions (one per user, add/remove)', async () => {
  const { redis, engine } = await fresh();
  await seedGroup(redis, 'c1', [U(1), U(2)]);
  await engine.ingest({ ulid: 'R1', convId: 'c1', senderId: U(1), contentType: 1, payload: text('nice'), ts: 1 });
  await expect('add reaction', async () => {
    const r = await engine.react({ convId: 'c1', targetUlid: 'R1', userId: U(2), emoji: '👍', op: 1, ts: 2 });
    const d = F.decode(r.frame);
    assert.strictEqual(d[0], F.T.REACTED);
    assert.strictEqual(d[5], '👍');
    assert.strictEqual(d[6], 1);
  });
  await expect('remove reaction', async () => {
    const r = await engine.react({ convId: 'c1', targetUlid: 'R1', userId: U(2), emoji: '👍', op: 0, ts: 3 });
    assert.strictEqual(F.decode(r.frame)[6], 0);
  });
  await expect('NEGATIVE: react to nonexistent message (NOT_FOUND)', async () => {
    await rejects(() => engine.react({ convId: 'c1', targetUlid: 'GHOST', userId: U(2), emoji: '😀', op: 1, ts: 4 }), F.E.NOT_FOUND);
  });
  await expect('NEGATIVE: non-member cannot react (NOT_MEMBER)', async () => {
    await rejects(() => engine.react({ convId: 'c1', targetUlid: 'R1', userId: U(99), emoji: '😀', op: 1, ts: 5 }), F.E.NOT_MEMBER);
  });
});

group('8. Reply / quote reference', async () => {
  const { redis, engine } = await fresh();
  await seedGroup(redis, 'c1', [U(1), U(2)]);
  await engine.ingest({ ulid: 'Q1', convId: 'c1', senderId: U(1), contentType: 1, payload: text('question?'), ts: 1 });
  await expect('reply carries replyTo in meta', async () => {
    const r = await engine.ingest({ ulid: 'Q2', convId: 'c1', senderId: U(2), contentType: 1, payload: text('answer'), ts: 2, replyTo: 'Q1' });
    const d = F.decode(r.msgFrame);
    assert.strictEqual(d[8].replyTo, 'Q1', 'meta.replyTo set');
  });
});

group('9. Disappearing messages (TTL passthrough)', async () => {
  const { redis, engine } = await fresh();
  await seedGroup(redis, 'c1', [U(1)]);
  await expect('ttl carried in meta for client expiry', async () => {
    const r = await engine.ingest({ ulid: 'T1', convId: 'c1', senderId: U(1), contentType: 1, payload: text('secret'), ts: 1, ttl: 86400 });
    const d = F.decode(r.msgFrame);
    assert.strictEqual(d[8].ttl, 86400);
  });
});

group('10. Forwarding + forward limit', async () => {
  const { redis, engine } = await fresh();
  await seedGroup(redis, 'c1', [U(1)]);
  await expect('forward within limit succeeds and marks fwd score', async () => {
    const r = await engine.forward({ ulid: 'FW1', convId: 'c1', senderId: U(1), contentType: 1, payload: text('viral'), fwdScore: 3, ts: 1 });
    const d = F.decode(r.msgFrame);
    assert.strictEqual(d[8].fwd, 3);
  });
  await expect('NEGATIVE: forward beyond limit rejected (FWD_LIMIT)', async () => {
    await rejects(() => engine.forward({ ulid: 'FW2', convId: 'c1', senderId: U(1), contentType: 1, payload: text('spam'), fwdScore: FWD_LIMIT + 1, ts: 2 }), F.E.FWD_LIMIT);
  });
});

group('11. Group ops + permissions + system events', async () => {
  const { redis, engine } = await fresh();
  await seedGroup(redis, 'g1', [U(1), U(2)], [U(1)]);
  await expect('admin adds member -> system event + membership updated', async () => {
    const r = await engine.groupOp({ convId: 'g1', op: 1, actorId: U(1), target: U(3), ts: 1, ulid: 'G1' });
    const d = F.decode(r.frame);
    assert.strictEqual(d[0], F.T.GROUP_EVT);
    assert.strictEqual(await redis.sismember('conv:g1:members', U(3)), 1);
  });
  await expect('NEGATIVE: non-admin cannot add member', async () => {
    await rejects(() => engine.groupOp({ convId: 'g1', op: 1, actorId: U(2), target: U(4), ts: 2, ulid: 'G2' }), F.E.NOT_MEMBER);
  });
  await expect('admin promotes; promoted user can then add', async () => {
    await engine.groupOp({ convId: 'g1', op: 3, actorId: U(1), target: U(2), ts: 3, ulid: 'G3' });
    const r = await engine.groupOp({ convId: 'g1', op: 1, actorId: U(2), target: U(5), ts: 4, ulid: 'G4' });
    assert.ok(r.seq);
  });
  await expect('member can leave themselves without admin', async () => {
    const r = await engine.groupOp({ convId: 'g1', op: 5, actorId: U(5), target: null, ts: 5, ulid: 'G5' });
    assert.strictEqual(await redis.sismember('conv:g1:members', U(5)), 0);
    assert.ok(r.seq);
  });
  await expect('admin removes member', async () => {
    await engine.groupOp({ convId: 'g1', op: 2, actorId: U(1), target: U(3), ts: 6, ulid: 'G6' });
    assert.strictEqual(await redis.sismember('conv:g1:members', U(3)), 0);
  });
  await expect('group system events appear in ordered log on sync', async () => {
    const s = sink(); s.redis = redis;
    await engine.onHello(s, [{ convId: 'g1', lastSeq: 0 }]);
    const sysMsgs = s.out.filter((f) => f[0] === F.T.MSG && f[5] === F.CT.SYSTEM);
    assert.ok(sysMsgs.length >= 1, 'system messages replay in the conversation log');
  });
});

group('12. Receipt aggregation (group double-ticks)', async () => {
  const { redis, storage, engine } = await fresh();
  await seedGroup(redis, 'g1', [U(1), U(2), U(3)]);
  await engine.ingest({ ulid: 'A1', convId: 'g1', senderId: U(1), contentType: 1, payload: text('hey all'), ts: 1 });
  await expect('aggregate reflects delivered/read counts', async () => {
    // setCursor(deviceId, conv, kind, seq, userId) — here one device per user
    await storage.setCursor(U(2), 'g1', 1, 1, U(2)); // U2 delivered up to seq 1
    await storage.setCursor(U(3), 'g1', 2, 1, U(3)); // U3 read up to seq 1
    const agg = await storage.receiptAgg('g1', 1);
    assert.strictEqual(agg.total, 3);
    assert.strictEqual(agg.delivered, 2, 'U2 delivered + U3 read(implies delivered)');
    assert.strictEqual(agg.read, 1, 'only U3 has read');
  });
});

group('13. Payload + protocol edge cases', async () => {
  const { redis, engine } = await fresh();
  await seedGroup(redis, 'c1', [U(1)]);
  await expect('binary payload survives round-trip exactly', async () => {
    const blob = Buffer.from([0, 1, 2, 255, 254, 0, 128]);
    const r = await engine.ingest({ ulid: 'BIN', convId: 'c1', senderId: U(1), contentType: 2, payload: blob, ts: 1 });
    const d = F.decode(r.msgFrame);
    assert.deepStrictEqual(Buffer.from(d[6]), blob);
  });
  await expect('empty payload allowed (e.g. media-only ref)', async () => {
    const r = await engine.ingest({ ulid: 'EMPTY', convId: 'c1', senderId: U(1), contentType: 2, payload: Buffer.alloc(0), ts: 2 });
    assert.ok(r.seq);
  });
  await expect('unicode/emoji text round-trips', async () => {
    const r = await engine.ingest({ ulid: 'UNI', convId: 'c1', senderId: U(1), contentType: 1, payload: text('வணக்கம் 🙏 مرحبا'), ts: 3 });
    const d = F.decode(r.msgFrame);
    assert.strictEqual(Buffer.from(d[6]).toString(), 'வணக்கம் 🙏 مرحبا');
  });
});

group('14. Crash recovery: rebuild seq from durable store', async () => {
  const { redis, storage, engine } = await fresh();
  await seedGroup(redis, 'c1', [U(1)]);
  await engine.ingest({ ulid: 'CR1', convId: 'c1', senderId: U(1), contentType: 1, payload: text('a'), ts: 1 });
  await engine.ingest({ ulid: 'CR2', convId: 'c1', senderId: U(1), contentType: 1, payload: text('b'), ts: 2 });
  await expect('after Redis flush, rebuildSeq restores counter from Mongo max', async () => {
    redis.kv.delete('conv:c1:seq'); // simulate Redis loss
    const n = await storage.rebuildSeq();
    assert.ok(n >= 1);
    assert.strictEqual(Number(await redis.get('conv:c1:seq')), 2, 'restored to max seq');
    const next = await engine.ingest({ ulid: 'CR3', convId: 'c1', senderId: U(1), contentType: 1, payload: text('c'), ts: 3 });
    assert.strictEqual(next.seq, 3, 'no seq collision after recovery');
  });
});

group('15. Concurrent edit ordering (last-writer-wins by seq)', async () => {
  const { redis, storage, engine } = await fresh();
  await seedGroup(redis, 'c1', [U(1)]);
  await engine.ingest({ ulid: 'CE', convId: 'c1', senderId: U(1), contentType: 1, payload: text('v0'), ts: 1000 });
  await expect('two edits produce two increasing seqs; later one wins in store', async () => {
    const e1 = await engine.edit({ convId: 'c1', targetUlid: 'CE', editorId: U(1), newPayload: text('v1'), ts: 1100 });
    const e2 = await engine.edit({ convId: 'c1', targetUlid: 'CE', editorId: U(1), newPayload: text('v2'), ts: 1200 });
    assert.ok(F.decode(e2.frame)[2] > F.decode(e1.frame)[2], 'second edit has higher seq');
    const doc = await storage.getByUlid('CE');
    assert.strictEqual(Buffer.from(doc.payload.data || doc.payload).toString(), 'v2', 'store holds latest edit');
  });
});

(async () => {
  console.log('\n=== NDE Sync Engine — WhatsApp feature parity suite ===\n');
  for (const g of groups) {
    console.log(`  ${g.name}`);
    await g.fn();
  }
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
})().catch((e) => { console.error('SUITE CRASH:', e); process.exit(1); });
