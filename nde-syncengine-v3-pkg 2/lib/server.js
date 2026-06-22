'use strict';
/**
 * Bootstrap one gateway node. Run N behind HAProxy (sticky by userId).
 * Env: PORT, REDIS_URL, MONGO_URL, MONGO_DB, SEQ_WINDOW, WS_JWT_PUBLIC_KEY
 */
const Redis = require('ioredis');
const { MongoClient } = require('mongodb');
const { CoreStore } = require('./core/storage');
const { makeEngine, buildDispatch } = require('./index');
const { Gateway } = require('./core/gateway');
const { FanOut } = require('./fanout');
const { runSweep } = require('./disappearing/wire');
const { verifyWsToken } = require('./auth');
const { startMetricsServer } = require('./metrics');

async function main() {
  const PORT = Number(process.env.PORT || 8090);
  const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  const MONGO_URL = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017';
  const MONGO_DB = process.env.MONGO_DB || 'nde_chat';
  const SEQ_WINDOW = Number(process.env.SEQ_WINDOW || 1);

  const redis = new Redis(REDIS_URL);
  const pub = new Redis(REDIS_URL);
  const sub = new Redis(REDIS_URL);

  const mongoClient = new MongoClient(MONGO_URL);
  await mongoClient.connect();
  const mongo = mongoClient.db(MONGO_DB);

  const storage = new CoreStore({ mongo, redis, seqWindow: SEQ_WINDOW });
  await storage.init();

  const engine = makeEngine({ storage });
  const dispatch = buildDispatch();
  const fanout = new FanOut({ pub, sub });

  // Task 1.2: RS256 JWT auth — verifyWsToken returns { userId, workspaceId, role }
  const auth = async (_deviceId, token) => verifyWsToken(token);

  const gw = new Gateway({ port: PORT, redis, fanout, engine, storage, auth, pushQueue: null, dispatch });
  gw.start();

  // Task 2.2: metrics sidecar on PORT+1
  startMetricsServer(PORT + 1, redis, mongoClient);

  // presence heartbeat
  setInterval(() => {
    const pipe = redis.pipeline();
    for (const uid of gw.byUser.keys()) pipe.set(`presence:${uid}`, '1', 'EX', 60);
    pipe.exec();
  }, 20000);

  // disappearing-message sweep for conversations this node holds sockets for
  setInterval(async () => {
    const now = Date.now();
    for (const convId of gw.convIndex.keys()) {
      try { await runSweep(gw, convId, now); } catch { /* per-conv best effort */ }
    }
  }, 30000);

  process.on('SIGTERM', async () => {
    clearInterval(gw._heartbeat);
    await storage._flushCursors(); // drain buffered receipt writes before shutdown
    await mongoClient.close();
    process.exit(0);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
