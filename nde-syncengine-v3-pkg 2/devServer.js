'use strict';
/**
 * Zero-dependency dev server — no Redis, no MongoDB required.
 * Uses in-memory fakes + a single-node LocalFanOut.
 *
 * Usage:  node devServer.js [--port 8090]
 *
 * Pre-seeded:
 *   Conversations : c1 (General), c2 (Team Chat)
 *   Members       : user1, user2 in both
 *   Admins        : user1 in both
 *   Auth          : token format = "<userId>" or "<userId>.anything"
 *                   e.g. token "user1" or "user1.secret" both auth as user1
 */

const { FakeRedis, FakeMongo } = require('./test/fakes');
const { CoreStore }             = require('./lib/core/storage');
const { makeEngine, buildDispatch } = require('./lib/index');
const { Gateway }               = require('./lib/core/gateway');
const { runSweep }              = require('./lib/disappearing/wire');
const { decode }                = require('cbor-x');

// Frame type name lookup for logs
const T_NAME = {
  0:'HELLO',1:'WELCOME',2:'SEND',3:'ACK',4:'MSG',5:'DELIVERED',6:'READ',
  7:'SYNC_REQ',8:'SYNC_GAP',9:'PRESENCE',10:'PING',11:'PONG',12:'RECEIPT',
  13:'ERR',14:'EDIT',15:'EDITED',16:'DELETE',17:'DELETED',18:'REACT',
  19:'REACTED',20:'TYPING',21:'TYPING_EVT',22:'GROUP_OP',23:'GROUP_EVT',
  24:'FORWARD',25:'RECEIPT_AGG',26:'PIN',27:'PINNED',28:'POLL',29:'POLL_CREATED',
  30:'VOTE',31:'POLL_TALLY',32:'VIEW_ONCE',33:'VIEWED',34:'EXPIRED',
  35:'CONV_TIMER',36:'TIMER_SET',37:'SUBJECT',38:'SUBJECT_SET',
};
function logFrame(dir, userId, buf) {
  try {
    const f = decode(buf instanceof Buffer ? buf : Buffer.from(buf));
    const name = T_NAME[f[0]] ?? f[0];
    if (f[0] === 10 || f[0] === 11) return; // skip PING/PONG
    console.log(`[gw] ${dir} ${userId ?? '?'} ${name}`, f.slice(1).map(v =>
      Buffer.isBuffer(v) ? `<buf ${v.length}B>` : v
    ));
  } catch {}
}

// ── Parse args ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const PORT = portIdx !== -1 ? Number(args[portIdx + 1]) : 8090;

// ── LocalFanOut — single-process, zero pub/sub overhead ──────────────────────
class LocalFanOut {
  constructor() {
    this.onMessage = null; // set by Gateway
  }
  async addInterest(convId)    { console.log(`[gw] +interest ${convId}`); }
  async removeInterest(convId) { console.log(`[gw] -interest ${convId}`); }
  publish(convId, frameBuffer) {
    logFrame('→ broadcast', convId, frameBuffer);
    if (this.onMessage) this.onMessage(convId, frameBuffer);
    return Promise.resolve(0);
  }
  publishBuffer(channel, frameBuffer) {
    const convId = channel.startsWith('conv:') ? channel.slice(5) : channel;
    return this.publish(convId, frameBuffer);
  }
}

// ── Auth — accept "userId" or "userId.anything" as a valid token ──────────────
async function auth(deviceId, token) {
  if (!token) throw new Error('unauthorized');
  const userId = token.split('.')[0];
  if (!userId) throw new Error('unauthorized');
  return { userId };
}

// ── Seed conversations and members ───────────────────────────────────────────
async function seed(redis) {
  const convs = [
    { id: 'c1', subject: 'General',   members: ['user1', 'user2', 'user3'], admins: ['user1'] },
    { id: 'c2', subject: 'Team Chat', members: ['user1', 'user2'],          admins: ['user1'] },
  ];
  for (const { id, subject, members, admins } of convs) {
    await redis.sadd(`conv:${id}:members`, ...members);
    await redis.sadd(`conv:${id}:admins`,  ...admins);
    await redis.set(`conv:${id}:subject`, subject);
  }
  console.log('  Seeded conversations:', convs.map(c => `${c.id} (${c.subject})`).join(', '));
  console.log('  Members: user1, user2, user3 in c1 | user1, user2 in c2');
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const redis   = new FakeRedis();
  const mongo   = new FakeMongo();
  const fanout  = new LocalFanOut();

  // CoreStore needs pub for sequences; pass same fake redis
  const storage = new CoreStore({ mongo, redis, seqWindow: 1 });
  await storage.init();

  await seed(redis);

  const engine   = makeEngine({ storage });
  const dispatch = buildDispatch();

  const gw = new Gateway({
    port: PORT,
    redis,
    fanout,
    engine,
    storage,
    auth,
    pushQueue: null,
    dispatch,
  });

  // Patch _onFrame to log every inbound frame
  const orig = gw._onFrame.bind(gw);
  gw._onFrame = async (session, data) => {
    logFrame('← recv', session.userId ?? session.deviceId, data);
    return orig(session, data);
  };

  gw.start();

  // Presence heartbeat (TTL ignored by FakeRedis — that's fine for dev)
  setInterval(() => {
    for (const uid of gw.byUser.keys()) redis.set(`presence:${uid}`, '1');
  }, 20_000);

  // Disappearing-message sweep
  setInterval(async () => {
    const now = Date.now();
    for (const convId of gw.convIndex.keys()) {
      try { await runSweep(gw, convId, now); } catch {}
    }
  }, 30_000);

  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║       NDE SyncEngine — Dev Server (in-memory)        ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Gateway  →  ws://localhost:${PORT}`);
  console.log('');
  console.log('  Auth: use token = userId  (e.g. "user1" or "user2")');
  console.log('');
  console.log('  Pre-seeded conversations:');
  console.log('    c1  General    — user1, user2, user3');
  console.log('    c2  Team Chat  — user1, user2');
  console.log('');
  console.log('  Open the frontend at http://localhost:5173');
  console.log('  Open a second tab with a different userId to chat');
  console.log('');
  console.log('  ⚠  Data is in-memory — clears on restart.');
  console.log('');
}

main().catch((e) => { console.error(e); process.exit(1); });
