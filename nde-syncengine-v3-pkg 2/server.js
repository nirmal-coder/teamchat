'use strict';
/**
 * Production-like dev server with real MongoDB + Redis.
 * HTTP (Express) on PORT_HTTP (default 3000)
 * WS  (Gateway)  on PORT_WS   (default 8090)
 *
 * Requires: MongoDB on MONGO_URL, Redis on REDIS_URL, JWT_SECRET in env
 * Copy .env.example to .env and adjust before starting.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express   = require('express');
const cors      = require('cors');
const Redis     = require('ioredis');
const { MongoClient } = require('mongodb');

const { CoreStore }             = require('./lib/core/storage');
const { makeEngine, buildDispatch } = require('./lib/index');
const { Gateway }               = require('./lib/core/gateway');
const { FanOut }                = require('./lib/fanout');
const { runSweep }              = require('./lib/disappearing/wire');
const { UserStore }             = require('./lib/users/store');
const { ulid }                  = require('./lib/common/ulid');

const PORT_HTTP = Number(process.env.PORT_HTTP || 3000);
const PORT_WS   = Number(process.env.PORT_WS   || 8090);
const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017/teamchat';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function send(res, status, body) { res.status(status).json(body); }
function apiErr(res, e) {
  const status = e.status || 500;
  console.error('[server]', e.message);
  send(res, status, { error: e.message });
}

async function bearerAuth(req, users) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) throw Object.assign(new Error('unauthorized'), { status: 401 });
  try {
    return await users.verify(h.slice(7));
  } catch {
    throw Object.assign(new Error('invalid or expired token'), { status: 401 });
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  // DB connections
  const mongo  = new MongoClient(MONGO_URL);
  await mongo.connect();
  const db     = mongo.db();
  const redis  = new Redis(REDIS_URL);
  const pubsub = new Redis(REDIS_URL); // separate connection for pub/sub

  // Stores
  const storage = new CoreStore({ mongo: db, redis, seqWindow: 1 });
  await storage.init();

  const users = new UserStore({ db, jwtSecret: JWT_SECRET });
  await users.init();

  // Engine + gateway
  const engine   = makeEngine({ storage });
  const dispatch = buildDispatch();
  const fanout   = new FanOut({ pub: redis, sub: pubsub });

  async function wsAuth(deviceId, token) {
    return users.verify(token); // returns { userId, username }
  }

  const gw = new Gateway({
    port: PORT_WS,
    redis,
    fanout,
    engine,
    storage,
    auth: wsAuth,
    pushQueue: null,
    dispatch,
  });
  gw.start();

  // ── Express HTTP ──────────────────────────────────────────────────────────
  const app = express();
  app.use(cors());
  app.use(express.json());

  // POST /register
  app.post('/register', async (req, res) => {
    try {
      const { username, password } = req.body;
      const userId = await users.register(username, password);
      const result = await users.login(username, password);
      send(res, 201, result);
    } catch (e) { apiErr(res, e); }
  });

  // POST /login
  app.post('/login', async (req, res) => {
    try {
      const { username, password } = req.body;
      const result = await users.login(username, password);
      send(res, 200, result);
    } catch (e) { apiErr(res, e); }
  });

  // GET /users
  app.get('/users', async (req, res) => {
    try {
      await bearerAuth(req, users);
      send(res, 200, await users.listAll());
    } catch (e) { apiErr(res, e); }
  });

  // POST /conversations  { type:'dm', targetUserId } | { type:'group', name, memberIds[] }
  app.post('/conversations', async (req, res) => {
    try {
      const { userId } = await bearerAuth(req, users);
      const { type, targetUserId, name, memberIds = [] } = req.body;

      let convId, subject, allMembers;

      if (type === 'dm') {
        if (!targetUserId) throw Object.assign(new Error('targetUserId required'), { status: 400 });
        convId     = 'dm:' + [userId, targetUserId].sort().join(':');
        const target = await users.findById(targetUserId);
        if (!target) throw Object.assign(new Error('user not found'), { status: 404 });
        const me   = await users.findById(userId);
        subject    = null; // DM: no subject; clients display the other person's name
        allMembers = [userId, targetUserId];
      } else if (type === 'group') {
        if (!name) throw Object.assign(new Error('name required for group'), { status: 400 });
        convId     = ulid();
        subject    = name;
        allMembers = [...new Set([userId, ...memberIds])];
      } else {
        throw Object.assign(new Error('type must be dm or group'), { status: 400 });
      }

      // Idempotent: check if conv already exists (DM case)
      const existingMembers = await storage.members(convId);
      if (existingMembers.length === 0) {
        // Set up conv
        for (const uid of allMembers) await storage.addMember(convId, uid);
        await storage.setAdmin(convId, userId, true);
        if (subject) await redis.set(`conv:${convId}:subject`, subject);
      }

      // Push to any online members (including this session)
      await gw.pushConvToOnlineMembers(convId);

      const memberDetails = await Promise.all(
        allMembers.map(uid => users.findById(uid).then(u => u || { userId: uid, username: uid }))
      );
      send(res, 200, { convId, subject, members: memberDetails });
    } catch (e) { apiErr(res, e); }
  });

  // Serialize a MongoDB message doc to a JSON-safe shape for the HTTP gap endpoint
  function serializeMsg(m) {
    const raw = m.payload
    let b64 = null
    if (raw) {
      // MongoDB returns bson.Binary; Redis cache returns a plain Buffer or {type,data}
      const buf = Buffer.isBuffer(raw) ? raw
        : raw?.buffer ? Buffer.from(raw.buffer) : Buffer.from(raw)
      b64 = buf.toString('base64')
    }
    return {
      ulid:        m._id,
      seq:         m.seq,
      senderId:    m.senderId,
      contentType: m.contentType,
      payload:     b64,
      ts:          m.ts,
      deleted:     !!m.deleted,
      expired:     !!m.expired,
      reactions:   m.reactions ?? {},
      meta: {
        replyTo: m.replyTo ?? null,
        ttl:     m.ttl     ?? 0,
        fwd:     m.fwd     ?? 0,
        edited:  !!m.edited,
      },
    }
  }

  // GET /conversations/:convId/messages?from=0&limit=100
  // Called by the client when SYNC_GAP is received (gap > LIVE_MAX).
  app.get('/conversations/:convId/messages', async (req, res) => {
    try {
      const { userId } = await bearerAuth(req, users)
      const { convId } = req.params
      const fromSeq = Math.max(0, Number(req.query.from ?? 0))
      const limit   = Math.min(Math.max(1, Number(req.query.limit ?? 100)), 200)

      if (!(await storage.isMember(convId, userId)))
        throw Object.assign(new Error('not a member'), { status: 403 })

      // Redis cache first (hot), fall back to MongoDB
      let msgs = typeof storage.rangeFromCache === 'function'
        ? await storage.rangeFromCache(convId, fromSeq, limit) : []
      if (msgs.length === 0)
        msgs = await storage.range(convId, fromSeq, limit)

      const maxSeq = Number(await redis.get(`conv:${convId}:seq`)) || 0

      send(res, 200, {
        messages: msgs.map(serializeMsg),
        maxSeq,
        hasMore: msgs.length === limit,
      })
    } catch (e) { apiErr(res, e) }
  })

  app.listen(PORT_HTTP, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║         NDE SyncEngine — Real Server                 ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`  HTTP API  →  http://localhost:${PORT_HTTP}`);
    console.log(`  Gateway   →  ws://localhost:${PORT_WS}`);
    console.log('');
    console.log(`  MongoDB   :  ${MONGO_URL}`);
    console.log(`  Redis     :  ${REDIS_URL}`);
    console.log('');
  });

  // Presence heartbeat
  setInterval(() => {
    for (const uid of gw.byUser.keys()) redis.set(`presence:${uid}`, '1', 'EX', 60);
  }, 20_000);

  // Disappearing-message sweep
  setInterval(async () => {
    const now = Date.now();
    for (const convId of gw.convIndex.keys()) {
      try { await runSweep(gw, convId, now); } catch {}
    }
  }, 30_000);
}

main().catch((e) => { console.error('[server] fatal:', e); process.exit(1); });
