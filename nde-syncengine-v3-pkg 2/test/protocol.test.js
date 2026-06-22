'use strict';
const assert = require('assert');
const F = require('../lib/common/frames');
const { ulid } = require('../lib/common/ulid');

let pass = 0;
const queue = [];
const ok = (name, fn) => queue.push({ name, fn });

console.log('protocol frames');
ok('SEND round-trips', () => {
  const payload = Buffer.from('hello');
  const buf = F.encode([F.T.SEND, '01J', 'conv1', 1, payload]);
  const d = F.decode(buf);
  assert.strictEqual(d[0], F.T.SEND);
  assert.strictEqual(d[1], '01J');
  assert.strictEqual(d[2], 'conv1');
  assert.deepStrictEqual(Buffer.from(d[4]), payload);
});

ok('ACK builder', () => {
  const d = F.decode(F.ack('U1', 'c1', 42, 1700));
  assert.deepStrictEqual(d, [F.T.ACK, 'U1', 'c1', 42, 1700]);
});

ok('MSG builder preserves binary payload', () => {
  const p = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
  const d = F.decode(F.msg('c1', 7, 'U1', 'user9', 1, p, 1700));
  assert.strictEqual(d[1], 'c1');
  assert.strictEqual(d[2], 7);
  assert.deepStrictEqual(Buffer.from(d[6]), p);
});

ok('SYNC_GAP useRest flag', () => {
  const d = F.decode(F.syncGap('c1', 10, 9000, 1));
  assert.strictEqual(d[4], 1);
});

console.log('ulid');
ok('26 chars, lexicographically sortable, monotonic', () => {
  const a = ulid(1000);
  const b = ulid(1000); // same ms -> monotonic increment
  const c = ulid(1001);
  assert.strictEqual(a.length, 26);
  assert.ok(a < b, 'monotonic within ms');
  assert.ok(b < c, 'later ms sorts after');
});

ok('many ulids strictly increasing', () => {
  let prev = '';
  for (let i = 0; i < 5000; i++) {
    const u = ulid();
    assert.ok(u > prev, `not increasing at ${i}: ${u} <= ${prev}`);
    prev = u;
  }
});

console.log('sync engine convergence logic');
// Stub storage + session to test gap routing without Redis/Mongo.
const { SyncEngine, LIVE_MAX } = require('../lib/compat');
ok('gap > LIVE_MAX forces REST backfill', async () => {
  const sent = [];
  const fakeRedis = { get: async () => String(10000) };
  const storage = { range: async () => [] };
  const eng = new SyncEngine({ storage });
  const session = { redis: fakeRedis, send: (b) => sent.push(F.decode(b)) };
  await eng.onHello(session, [{ convId: 'c1', lastSeq: 0 }]);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0][0], F.T.SYNC_GAP);
  assert.strictEqual(sent[0][4], 1, 'useRest set');
});

ok('small gap replays inline as MSG frames', async () => {
  const sent = [];
  const fakeRedis = { get: async () => String(3) };
  const docs = [
    { _id: 'U1', seq: 1, senderId: 'a', contentType: 1, payload: Buffer.from('x'), ts: 1 },
    { _id: 'U2', seq: 2, senderId: 'a', contentType: 1, payload: Buffer.from('y'), ts: 2 },
    { _id: 'U3', seq: 3, senderId: 'a', contentType: 1, payload: Buffer.from('z'), ts: 3 },
  ];
  let served = false;
  const storage = { range: async () => { if (served) return []; served = true; return docs; } };
  const eng = new SyncEngine({ storage });
  const session = { redis: fakeRedis, send: (b) => sent.push(F.decode(b)) };
  await eng.onHello(session, [{ convId: 'c1', lastSeq: 0 }]);
  assert.strictEqual(sent.length, 3);
  assert.ok(sent.every((f) => f[0] === F.T.MSG));
  assert.deepStrictEqual(sent.map((f) => f[1]), ['c1', 'c1', 'c1']);
  assert.deepStrictEqual(sent.map((f) => f[2]), [1, 2, 3]);
});

ok('ingest dedups on ulid (at-least-once safe)', async () => {
  const store = new Map();
  let seqCounter = 0;
  const storage = {
    isMember: async () => true,
    ingest: async ({ ulid: u, convId }) => {
      if (store.has(u)) return { seq: store.get(u), ts: 1, duplicate: true };
      const seq = ++seqCounter; store.set(u, seq);
      return { seq, ts: 1, duplicate: false };
    },
  };
  const eng = new SyncEngine({ storage });
  const first = await eng.ingest({ ulid: 'U1', convId: 'c1', senderId: 'a', contentType: 1, payload: Buffer.from('x'), ts: 1 });
  const resend = await eng.ingest({ ulid: 'U1', convId: 'c1', senderId: 'a', contentType: 1, payload: Buffer.from('x'), ts: 1 });
  assert.strictEqual(first.seq, 1);
  assert.strictEqual(first.msgFrame !== null, true, 'first broadcasts');
  assert.strictEqual(resend.seq, 1, 'same seq on resend');
  assert.strictEqual(resend.msgFrame, null, 'duplicate does not re-broadcast');
});

(async () => {
  for (const { name, fn } of queue) {
    await fn();
    pass++;
    console.log('  ok -', name);
  }
  console.log(`\nLIVE_MAX = ${LIVE_MAX}`);
  console.log(`\n${pass} checks passed`);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
