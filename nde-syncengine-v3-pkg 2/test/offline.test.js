'use strict';
/**
 * Offline / reconnect sync suite — the "server up, recipient offline, then
 * reconnects and catches up" scenario, end-to-end through the real Gateway.
 *
 * Two mechanisms are exercised:
 *   1) Offline inbox: while B is disconnected, A's messages are queued to B's
 *      Redis Stream inbox; on B's reconnect, drainInbox replays them.
 *   2) Gap-fill: B reconnects with a stale lastSeq; onHello streams the delta.
 */
const assert = require('assert');
const { WebSocket } = require('ws');
const F = require('../lib/common/frames');
const { CoreStore } = require('../lib/core/storage');
const { makeEngine, buildDispatch } = require('../lib/index');
const { Gateway } = require('../lib/core/gateway');
const { FakeRedis, FakeMongo } = require('./fakes');

let passed = 0, failed = 0;
async function expect(name, fn) {
  try { await fn(); passed++; console.log(`    PASS  ${name}`); }
  catch (e) { failed++; console.log(`    FAIL  ${name}\n          ${e.message}`); }
}

class Loop {
  constructor() { this.onMessage = null; }
  async addInterest() {} async removeInterest() {}
  async publish(c, f) { if (this.onMessage) this.onMessage(c, f); }
}
class Client {
  constructor(url) {
    this.ws = new WebSocket(url); this.frames = []; this.cursor = 0; this.waiters = [];
    this.ws.on('message', (d) => {
      const f = F.decode(d); this.frames.push(f);
      this.waiters = this.waiters.filter((w) => { if (w.type === f[0]) { w.resolve(f); return false; } return true; });
    });
  }
  open() { return new Promise((r) => this.ws.on('open', r)); }
  send(b) { this.ws.send(b); }
  count(type) { return this.frames.filter((f) => f[0] === type).length; }
  all(type) { return this.frames.filter((f) => f[0] === type); }
  next(type, ms = 1500) {
    for (let i = this.cursor; i < this.frames.length; i++) if (this.frames[i][0] === type) { this.cursor = i + 1; return Promise.resolve(this.frames[i]); }
    this.cursor = this.frames.length;
    return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(`timeout type ${type}`)), ms); this.waiters.push({ type, resolve: (f) => { clearTimeout(t); res(f); } }); });
  }
  close() { return new Promise((r) => { this.ws.on('close', r); this.ws.close(); }); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (s) => Buffer.from(s);

(async () => {
  console.log('\n=== NDE Sync Engine — offline & reconnect sync (real WebSocket) ===\n');
  const redis = new FakeRedis();
  const storage = new CoreStore({ mongo: new FakeMongo(), redis });
  await storage.init();
  const engine = makeEngine({ storage });
  await redis.sadd('conv:room:members', 'alice', 'bob');
  const auth = async (deviceId, token) => ({ userId: token.split('.')[0] });
  const gw = new Gateway({ port: 0, redis, fanout: new Loop(), engine, storage, auth, pushQueue: null, dispatch: buildDispatch() });
  gw.start();
  const url = `ws://127.0.0.1:${gw.wss.address().port}`;

  // Alice connects and stays online. Bob connects, then goes offline.
  const alice = new Client(url); await alice.open();
  alice.send(F.encode([F.T.HELLO, 'a1', 'alice.a1', [{ convId: 'room', lastSeq: 0 }]]));
  await alice.next(F.T.WELCOME);

  let bob = new Client(url); await bob.open();
  bob.send(F.encode([F.T.HELLO, 'b1', 'bob.b1', [{ convId: 'room', lastSeq: 0 }]]));
  await bob.next(F.T.WELCOME);

  // Alice sends 1 message Bob receives live, establishing Bob's lastSeq=1.
  alice.send(F.encode([F.T.SEND, 'M1', 'room', 1, text('before bob leaves')]));
  await bob.next(F.T.MSG);

  await expect('Bob goes offline; presence key is cleared on disconnect', async () => {
    await bob.close();
    await wait(80);
    assert.strictEqual(await redis.exists('presence:bob'), 0, 'bob no longer present');
  });

  // While Bob is offline, Alice sends 3 more. They must queue to Bob's inbox.
  await expect('messages sent while Bob offline are queued to his inbox', async () => {
    for (const [u, t] of [['M2', 'while you were away 1'], ['M3', 'while you were away 2'], ['M4', 'while you were away 3']]) {
      alice.send(F.encode([F.T.SEND, u, 'room', 1, text(t)]));
      await alice.next(F.T.ACK);
    }
    await wait(50);
    const inbox = await redis.xrange('user:bob:inbox', '-', '+');
    assert.strictEqual(inbox.length, 3, 'three messages queued for offline bob');
  });

  // Bob reconnects with lastSeq reflecting only what he saw live (seq 1).
  await expect('Bob reconnects and drains all 3 queued messages', async () => {
    bob = new Client(url); await bob.open();
    bob.send(F.encode([F.T.HELLO, 'b1', 'bob.b1', [{ convId: 'room', lastSeq: 1 }]]));
    await bob.next(F.T.WELCOME);
    await wait(80);
    // drained from inbox: M2,M3,M4 arrive as MSG frames
    const msgs = bob.all(F.T.MSG);
    assert.ok(msgs.length >= 3, `expected >=3 messages on reconnect, got ${msgs.length}`);
    const bodies = msgs.map((m) => Buffer.from(m[6]).toString());
    assert.ok(bodies.some((b) => b === 'while you were away 1'));
    assert.ok(bodies.some((b) => b === 'while you were away 3'));
  });

  await expect('inbox is cleared after drain (no double-delivery on next reconnect)', async () => {
    const inbox = await redis.xrange('user:bob:inbox', '-', '+');
    assert.strictEqual(inbox.length, 0, 'inbox emptied after drain');
  });

  // Independent path: gap-fill. Bob with a very stale cursor gets the delta via replay.
  await expect('reconnect with stale lastSeq replays the missed delta (gap-fill)', async () => {
    const b2 = new Client(url); await b2.open();
    b2.send(F.encode([F.T.HELLO, 'b2', 'bob.b2', [{ convId: 'room', lastSeq: 0 }]])); // new device, knows nothing
    await b2.next(F.T.WELCOME);
    await wait(80);
    // onHello replays all 4 messages (seq 1..4) for the fresh cursor
    const msgs = b2.all(F.T.MSG);
    assert.ok(msgs.length >= 4, `gap-fill should replay >=4, got ${msgs.length}`);
    const seqs = msgs.map((m) => m[2]).sort((x, y) => x - y);
    assert.strictEqual(seqs[0], 1, 'replay starts at seq 1');
    await b2.close();
  });

  await alice.close(); await bob.close();
  await wait(50);
  clearInterval(gw._heartbeat); gw.wss.close();
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
