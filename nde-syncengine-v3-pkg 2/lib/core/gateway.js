'use strict';
/**
 * Stateless WebSocket gateway, dispatch-table driven.
 *
 * Core frames (HELLO/SEND/receipts/edit/delete/react/group/forward/typing) are
 * handled inline; optional features register their own handlers via the
 * dispatch table built by lib/index.buildDispatch(). Public helpers
 * (queueOffline, deliverLocal) are stable so feature wire-slices can call them.
 *
 * PERF (balanced):
 *  - convIndex: Map<convId, Set<Session>> so fan-out delivery is O(interested),
 *    not O(all local sockets). The old code scanned every session per frame.
 *  - Session.send applies backpressure (drops to a slow consumer past 4MB).
 *  - token-bucket rate limiting per socket.
 *  - perMessageDeflate disabled (CBOR is already compact; deflate adds latency).
 *  - offline presence checks are pipelined into one Redis round-trip.
 */
const { WebSocketServer } = require('ws');
const F = require('../common/frames');
const { messagesIngested, activeConns, activeConvs } = require('../metrics');

class Session {
  constructor(ws, redis) {
    this.ws = ws; this.redis = redis;
    this.deviceId = null; this.userId = null;
    this.convs = new Set();
    this.alive = true;
    this.tokens = 30; this.lastRefill = Date.now();
    this.RATE_CAP = 30; this.RATE_REFILL = 20;
    this.MAX_BACKPRESSURE = 4 * 1024 * 1024;
  }
  send(buf) {
    if (this.ws.readyState !== 1) return false;
    if (this.ws.bufferedAmount > this.MAX_BACKPRESSURE) return false; // slow consumer
    this.ws.send(buf); return true;
  }
  allow() {
    const now = Date.now();
    this.tokens = Math.min(this.RATE_CAP, this.tokens + ((now - this.lastRefill) / 1000) * this.RATE_REFILL);
    this.lastRefill = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1; return true;
  }
}

class Gateway {
  constructor({ port, redis, fanout, engine, storage, auth, pushQueue, dispatch }) {
    this.port = port; this.redis = redis; this.fanout = fanout;
    this.engine = engine; this.storage = storage; this.auth = auth; this.pushQueue = pushQueue;
    this.dispatch = dispatch || {};        // feature handlers: type -> (gw, s, frame) => Promise
    this.sessions = new Set();
    this.byUser = new Map();               // userId -> Set<Session>
    this.convIndex = new Map();            // convId -> Set<Session>  (PERF: targeted fan-out)
    this.MAX_PAYLOAD = 64 * 1024;
    this.fanout.onMessage = (convId, frame) => this.deliverLocal(convId, frame);
  }

  start() {
    this.wss = new WebSocketServer({ port: this.port, perMessageDeflate: false });
    this.wss.on('connection', (ws) => this._onConnect(ws));
    this._heartbeat = setInterval(() => this._reap(), 30000);
    if (this.port) console.log(`[gateway] listening :${this.port}`);
  }

  _onConnect(ws) {
    const s = new Session(ws, this.redis);
    this.sessions.add(s);
    activeConns.inc();
    ws.on('message', (data) => this._onFrame(s, data).catch((e) => s.send(F.err(e.code || 500, String(e.message || e)))));
    ws.on('close', () => this._onClose(s));
    ws.on('pong', () => { s.alive = true; });
  }

  async _onFrame(s, data) {
    const frame = F.decode(data);
    const type = frame[0];
    // core frames handled inline
    switch (type) {
      case F.T.HELLO:     return this._onHello(s, frame);
      case F.T.SEND:      return this._guard(s, () => this._onSend(s, frame));
      case F.T.DELIVERED: return this._onReceipt(s, frame, 1);
      case F.T.READ:      return this._onReceipt(s, frame, 2);
      case F.T.SYNC_REQ:  return this.engine.onSyncReq(s, frame[1], frame[2]);
      case F.T.PRESENCE:  return this._onPresence(s, frame);
      case F.T.EDIT:      return this._guard(s, () => this._broadcast(s, this.engine.edit({ convId: frame[2], targetUlid: frame[3], editorId: s.userId, newPayload: frame[4], ts: Date.now() })));
      case F.T.DELETE:    return frame[4] === F.DEL.EVERYONE ? this._guard(s, () => this._broadcast(s, this.engine.deleteForEveryone({ convId: frame[2], targetUlid: frame[3], deleterId: s.userId, ts: Date.now() }))) : undefined;
      case F.T.REACT:     return this._guard(s, () => this._broadcast(s, this.engine.react({ convId: frame[2], targetUlid: frame[3], userId: s.userId, emoji: frame[4], op: frame[5], ts: Date.now() })));
      case F.T.TYPING:    return this._onTyping(s, frame);
      case F.T.GROUP_OP:  return this._guard(s, () => this._onGroupOp(s, frame));
      case F.T.FORWARD:   return this._guard(s, () => this._onForward(s, frame));
      case F.T.PING:      return s.send(F.pong(frame[1]));
    }
    // feature frames via dispatch table
    const handler = this.dispatch[type];
    if (handler) return this._guard(s, () => handler(this, s, frame));
    return s.send(F.err(400, 'unknown frame'));
  }

  async _guard(s, fn) {
    if (!s.allow()) return s.send(F.err(F.E.RATE_LIMITED, 'slow down'));
    try { await fn(); }
    catch (e) { s.send(F.err(e.code || F.E.INTERNAL, String(e.message || e))); }
  }

  /** Await an engine op that returns {frame, convId?} and broadcast it. */
  async _broadcast(s, promise) {
    const { frame } = await promise;
    // convId is frame[1] for all s->c event frames in our protocol
    const convId = F.decode(frame)[1];
    await this.fanout.publish(convId, frame);
  }

  async _onHello(s, [, deviceId, token, cursors]) {
    const { userId } = await this.auth(deviceId, token);
    s.deviceId = deviceId; s.userId = userId;
    if (!this.byUser.has(userId)) this.byUser.set(userId, new Set());
    this.byUser.get(userId).add(s);
    await this.redis.set(`presence:${userId}`, '1', 'EX', 60);

    const clientConvIds = new Set((cursors || []).map(c => c.convId));
    const serverConvs   = this.storage.getConvsForUser ? await this.storage.getConvsForUser(userId) : [];
    const fullList      = [...(cursors || [])];
    for (const convId of serverConvs) {
      if (!clientConvIds.has(convId)) fullList.push({ convId, lastSeq: 0 });
    }

    for (const { convId } of fullList) {
      s.convs.add(convId);
      this._indexAdd(convId, s);
      await this.fanout.addInterest(convId);
    }

    s.send(F.welcome(Date.now(), `${userId}:${deviceId}`));
    await this.engine.onHello(s, fullList);
    await this.drainInbox(s);

    // Push metadata for convs the client didn't know about
    for (const convId of serverConvs) {
      if (!clientConvIds.has(convId)) await this._pushConvMeta(s, convId);
    }
  }

  async _pushConvMeta(s, convId) {
    const [members, admins, subject] = await Promise.all([
      this.storage.members(convId),
      this.redis.smembers(`conv:${convId}:admins`),
      this.redis.get(`conv:${convId}:subject`),
    ]);
    const now = Date.now();
    // actorId=uid, target=uid (self-join style) so client GROUP_EVT handler
    // correctly adds `target` to the members/admins array
    for (const uid of members)  s.send(F.groupEvt(convId, 0, 1, uid, uid, now));
    for (const uid of admins)   s.send(F.groupEvt(convId, 0, 3, uid, uid, now));
    if (subject) s.send(F.subjectSet(convId, 0, '__server__', 'subject', subject, now));
  }

  async pushConvToOnlineMembers(convId) {
    const members = await this.storage.members(convId);
    for (const uid of members) {
      for (const sess of this.byUser.get(uid) || []) {
        if (!sess.convs.has(convId)) {
          sess.convs.add(convId);
          this._indexAdd(convId, sess);
          await this.fanout.addInterest(convId);
        }
        await this._pushConvMeta(sess, convId);
      }
    }
  }

  async _onSend(s, frame) {
    const [, ulid, convId, contentType, payload, replyTo, ttl] = frame;
    if (payload && payload.length > this.MAX_PAYLOAD) return s.send(F.err(F.E.PAYLOAD_TOO_LARGE, 'use media upload ref'));
    const { ackFrame, msgFrame, seq } = await this.engine.ingest({
      ulid, convId, senderId: s.userId, contentType, payload, ts: Date.now(), replyTo: replyTo || null, ttl: ttl || 0 });
    s.send(ackFrame);
    if (!msgFrame) return;
    messagesIngested.inc();
    await this.fanout.publish(convId, msgFrame);
    await this.queueOffline(convId, seq, msgFrame, s.userId);
  }

  async _onReceipt(s, [, convId, seq], kind) {
    await this.storage.setCursor(s.deviceId, convId, kind, seq, s.userId);
    await this.fanout.publish(convId, F.receipt(convId, seq, s.userId, kind));
    const agg = await this.storage.receiptAgg(convId, seq);
    if (agg.total > 2) await this.fanout.publish(convId, F.receiptAgg(convId, seq, agg.delivered, agg.read, agg.total));
  }

  async _onPresence(s, frame) {
    const buf = F.encode(frame);
    for (const convId of s.convs) await this.fanout.publish(convId, buf);
  }

  async _onTyping(s, [, convId, state]) {
    await this.fanout.publish(convId, F.typingEvt(convId, s.userId, state, Date.now() + 6000));
  }

  async _onGroupOp(s, [, ulid, convId, op, target]) {
    const { frame } = await this.engine.groupOp({ convId, op, actorId: s.userId, target: target || null, ts: Date.now(), ulid });
    await this.fanout.publish(convId, frame);
    if (op === 2 || op === 5) {
      const gone = op === 5 ? s.userId : target;
      for (const sess of this.byUser.get(gone) || []) {
        if (sess.convs.has(convId)) { sess.convs.delete(convId); this._indexRemove(convId, sess); await this.fanout.removeInterest(convId); }
      }
    }
  }

  async _onForward(s, [, ulid, convId, srcUlid, contentType, payload, fwdScore]) {
    const { ackFrame, msgFrame, seq } = await this.engine.forward({
      ulid, convId, senderId: s.userId, contentType, payload, fwdScore: fwdScore || 1, ts: Date.now() });
    s.send(ackFrame);
    if (!msgFrame) return;
    await this.fanout.publish(convId, msgFrame);
    await this.queueOffline(convId, seq, msgFrame, s.userId);
  }

  // ---- public helpers (features call these) ----

  /** PERF: deliver only to sockets indexed for this conversation. */
  deliverLocal(convId, frame) {
    const set = this.convIndex.get(convId);
    if (!set) return;
    for (const s of set) s.send(frame);
  }

  /** Queue to offline members' inboxes + enqueue push. One pipelined RTT for presence. */
  async queueOffline(convId, seq, frame, senderId) {
    const members = await this.storage.members(convId);
    if (!members.length) return;
    const pipe = this.redis.pipeline();
    const targets = members.filter((u) => u !== senderId);
    for (const uid of targets) pipe.exists(`presence:${uid}`);
    const results = await pipe.exec();
    const offline = [];
    for (let i = 0; i < targets.length; i++) {
      if (results[i][1] !== 1) {
        await this.redis.xadd(`user:${targets[i]}:inbox`, 'MAXLEN', '~', '1000', '*', 'c', convId, 'seq', String(seq), 'f', frame);
        offline.push(targets[i]);
      }
    }
    if (offline.length && this.pushQueue) await this.pushQueue.add('push', { convId, seq, users: offline });
  }

  async drainInbox(s) {
    const key = `user:${s.userId}:inbox`;
    const entries = await this.redis.xrange(key, '-', '+', 'COUNT', 500);
    for (const [, fields] of entries) {
      const fIdx = fields.indexOf('f');
      if (fIdx !== -1) s.send(fields[fIdx + 1]);
    }
    if (entries.length) await this.redis.xtrim(key, 'MAXLEN', 0);
  }

  // ---- conv index maintenance ----
  _indexAdd(convId, s) {
    let set = this.convIndex.get(convId);
    if (!set) { set = new Set(); this.convIndex.set(convId, set); }
    set.add(s);
    activeConvs.set(this.convIndex.size);
  }
  _indexRemove(convId, s) {
    const set = this.convIndex.get(convId);
    if (set) { set.delete(s); if (set.size === 0) this.convIndex.delete(convId); }
    activeConvs.set(this.convIndex.size);
  }

  async _onClose(s) {
    this.sessions.delete(s);
    activeConns.dec();
    if (s.userId && this.byUser.has(s.userId)) {
      const set = this.byUser.get(s.userId);
      set.delete(s);
      if (set.size === 0) { this.byUser.delete(s.userId); await this.redis.del(`presence:${s.userId}`); }
    }
    for (const convId of s.convs) { this._indexRemove(convId, s); await this.fanout.removeInterest(convId); }
  }

  _reap() {
    for (const s of this.sessions) {
      if (!s.alive) { s.ws.terminate(); continue; }
      s.alive = false;
      try { s.ws.ping(); } catch { /* closing */ }
    }
  }
}

module.exports = { Gateway, Session };
