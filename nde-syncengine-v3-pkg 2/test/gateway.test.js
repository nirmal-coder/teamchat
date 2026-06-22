'use strict';
/**
 * End-to-end gateway integration test. Spins up the REAL Gateway over a real
 * WebSocket server (loopback), backed by in-memory Redis/Mongo fakes and an
 * in-process fan-out. Two clients connect to the same conversation; we drive
 * actual wire frames and assert the broadcasts each client receives.
 *
 * Focus: the round-2 handlers newly wired into dispatch (PIN, POLL, VOTE,
 * VIEW_ONCE, CONV_TIMER, SUBJECT) plus a baseline SEND to prove the path.
 */
const assert = require('assert');
const { WebSocket } = require('ws');
const F = require('../lib/common/frames');
const { Storage } = require('../lib/compat');
const { SyncEngine } = require('../lib/compat');
const { Gateway } = require('../lib/core/gateway');
const { buildDispatch } = require('../lib/index');
const { FakeRedis, FakeMongo } = require('./fakes');

let passed = 0, failed = 0;
async function expect(name, fn) {
  try { await fn(); passed++; console.log(`    PASS  ${name}`); }
  catch (e) { failed++; console.log(`    FAIL  ${name}\n          ${e.message}`); }
}

// In-process fan-out: loopback publish to local interested sockets only.
class LoopFanOut {
  constructor() { this.interest = new Map(); this.onMessage = null; }
  async addInterest(c) { this.interest.set(c, (this.interest.get(c) || 0) + 1); }
  async removeInterest(c) {
    const n = (this.interest.get(c) || 0) - 1;
    if (n <= 0) this.interest.delete(c); else this.interest.set(c, n);
  }
  async publish(convId, frame) { if (this.onMessage) this.onMessage(convId, frame); }
}

// Minimal client: collects decoded frames, supports awaiting the next frame of a type.
class Client {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.frames = [];
    this.cursor = 0; // frames before this index are already consumed by next()
    this.waiters = [];
    this.ws.on('message', (data) => {
      const f = F.decode(data);
      this.frames.push(f);
      this.waiters = this.waiters.filter((w) => { if (w.type === f[0]) { w.resolve(f); return false; } return true; });
    });
  }
  open() { return new Promise((res) => this.ws.on('open', res)); }
  send(buf) { this.ws.send(buf); }
  next(type, ms = 1500) {
    // only consider frames not yet consumed, so stale ERRs from a prior step
    // never satisfy a later wait.
    for (let i = this.cursor; i < this.frames.length; i++) {
      if (this.frames[i][0] === type) { this.cursor = i + 1; return Promise.resolve(this.frames[i]); }
    }
    this.cursor = this.frames.length;
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout waiting for frame type ${type}`)), ms);
      this.waiters.push({ type, resolve: (f) => { clearTimeout(t); this.cursor = this.frames.length; res(f); } });
    });
  }
  close() { this.ws.close(); }
}

const text = (s) => Buffer.from(s);

(async () => {
  console.log('\n=== NDE Sync Engine — gateway end-to-end (real WebSocket) ===\n');

  const redis = new FakeRedis();
  const storage = new Storage({ mongo: new FakeMongo(), redis });
  await storage.init();
  const engine = new SyncEngine({ storage });
  const fanout = new LoopFanOut();

  // group g1 with two members; u1 is admin
  await redis.sadd('conv:g1:members', 'u1', 'u2');
  await redis.sadd('conv:g1:admins', 'u1');

  // token format "userId.device" -> auth returns userId
  const auth = async (deviceId, token) => ({ userId: token.split('.')[0] });
  const gw = new Gateway({ port: 0, redis, fanout, engine, storage, auth, pushQueue: null, dispatch: buildDispatch() });
  gw.start();
  const port = gw.wss.address().port;
  const url = `ws://127.0.0.1:${port}`;

  const a = new Client(url); await a.open();
  const b = new Client(url); await b.open();

  // both say HELLO for g1
  a.send(F.encode([F.T.HELLO, 'dev-a', 'u1.a', [{ convId: 'g1', lastSeq: 0 }]]));
  b.send(F.encode([F.T.HELLO, 'dev-b', 'u2.b', [{ convId: 'g1', lastSeq: 0 }]]));
  await a.next(F.T.WELCOME); await b.next(F.T.WELCOME);

  await expect('SEND from A is broadcast to B as MSG', async () => {
    a.send(F.encode([F.T.SEND, 'WIRE1', 'g1', 1, text('hello over the wire')]));
    await a.next(F.T.ACK);
    const msg = await b.next(F.T.MSG);
    assert.strictEqual(msg[2], 1, 'seq 1');
    assert.strictEqual(Buffer.from(msg[6]).toString(), 'hello over the wire');
  });

  await expect('POLL creates poll; B receives POLL_CREATED', async () => {
    a.send(F.encode([F.T.POLL, 'POLLW', 'g1', 'Tea or coffee?', ['Tea', 'Coffee'], 0]));
    const pc = await b.next(F.T.POLL_CREATED);
    assert.deepStrictEqual(pc[6], ['Tea', 'Coffee']);
  });

  await expect('VOTE from B yields POLL_TALLY seen by A', async () => {
    b.send(F.encode([F.T.VOTE, 'V-1', 'g1', 'POLLW', [1]]));
    const tally = await a.next(F.T.POLL_TALLY);
    assert.deepStrictEqual(tally[4], [0, 1], 'one vote for Coffee');
  });

  await expect('PIN broadcasts PINNED to both', async () => {
    a.send(F.encode([F.T.PIN, 'PINW', 'g1', 'WIRE1', 1]));
    const p = await b.next(F.T.PINNED);
    assert.strictEqual(p[3], 'WIRE1');
    assert.strictEqual(p[5], 1, 'pinned on');
  });

  await expect('CONV_TIMER broadcasts TIMER_SET', async () => {
    a.send(F.encode([F.T.CONV_TIMER, 'TW', 'g1', 86400]));
    const t = await b.next(F.T.TIMER_SET);
    assert.strictEqual(t[4], 86400);
  });

  await expect('SUBJECT (admin) broadcasts SUBJECT_SET', async () => {
    a.send(F.encode([F.T.SUBJECT, 'SUBW', 'g1', 'subject', 'Wire Team']));
    const sset = await b.next(F.T.SUBJECT_SET);
    assert.strictEqual(sset[5], 'Wire Team');
  });

  await expect('NEGATIVE: non-admin SUBJECT change returns ERR(NOT_ADMIN) to sender', async () => {
    b.send(F.encode([F.T.SUBJECT, 'SUBW2', 'g1', 'subject', 'hijack']));
    const err = await b.next(F.T.ERR);
    assert.strictEqual(err[1], F.E.NOT_ADMIN);
  });

  await expect('VIEW_ONCE: A sends view-once, B views -> VIEWED broadcast', async () => {
    a.send(F.encode([F.T.SEND, 'VO1', 'g1', 9 /*VIEW_ONCE*/, text('once.jpg')]));
    await a.next(F.T.ACK);
    b.send(F.encode([F.T.VIEW_ONCE, 'VOW', 'g1', 'VO1']));
    const v = await a.next(F.T.VIEWED);
    assert.strictEqual(v[3], 'VO1');
    assert.strictEqual(v[4], 'u2', 'viewer is B');
  });

  await expect('NEGATIVE: second VIEW_ONCE returns ERR(ALREADY_VIEWED)', async () => {
    b.send(F.encode([F.T.VIEW_ONCE, 'VOW2', 'g1', 'VO1']));
    const err = await b.next(F.T.ERR);
    assert.strictEqual(err[1], F.E.ALREADY_VIEWED);
  });

  await expect('READ receipt from B reaches A as RECEIPT', async () => {
    b.send(F.encode([F.T.READ, 'g1', 1]));
    const r = await a.next(F.T.RECEIPT);
    assert.strictEqual(r[4], 2, 'kind=read');
    assert.strictEqual(r[3], 'u2');
  });

  a.close(); b.close();
  await new Promise((r) => setTimeout(r, 50));
  clearInterval(gw._heartbeat);
  gw.wss.close();

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
