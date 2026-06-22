'use strict';
/**
 * Core storage — the shared persistence base. Holds the Mongo collections,
 * Redis handle, the optional SeqBatcher, and the always-on operations
 * (ingest, range/replay, cursors, membership, edit/delete/react, receipts).
 *
 * Feature stores (pin, poll, ...) receive { col, cursors, convs, redis, batcher, updateCachedDoc }
 * from this object and own only their slice of state.
 *
 * CACHE DESIGN
 *   conv:{convId}:cache        → sorted set  score=seq, member=ulid
 *   conv:{convId}:cache:docs   → hash        field=ulid, value=JSON
 *
 * Using ULID as the sorted-set member lets us overwrite a doc in the companion
 * hash without scanning or re-inserting a new sorted-set entry — O(1) updates
 * for edit/delete/expire operations.
 */
const { nextSeq, SeqBatcher } = require('../common/seq');

const CACHE_KEY = (convId) => `conv:${convId}:cache`;
const DOCS_KEY = (convId) => `conv:${convId}:cache:docs`;
const CACHE_MAX = 500;
const CURSOR_FLUSH_MS = 200;

class CoreStore {
  constructor({ mongo, redis, seqWindow = 1 }) {
    this.redis = redis;
    this.col = mongo.collection('messages');
    this.cursors = mongo.collection('cursors');
    this.convs = mongo.collection('conversations');
    this.batcher = seqWindow > 1 ? new SeqBatcher(redis, seqWindow) : null;
    this._cursorBuffer = new Map();
    this._cursorTimer = null;
  }

  /** Shared bundle handed to feature stores so they reuse one connection set. */
  bundle() {
    return {
      col: this.col, cursors: this.cursors, convs: this.convs,
      redis: this.redis, batcher: this.batcher,
      updateCachedDoc: this.updateCachedDoc.bind(this),
    };
  }

  async init() {
    await this.col.createIndex({ convId: 1, seq: 1 }, { unique: true });
    await this.col.createIndex({ _id: 1 });
    await this.col.createIndex({ convId: 1, ts: 1 });
    await this.cursors.createIndex({ deviceId: 1, convId: 1 }, { unique: true });
    await this.convs.createIndex({ _id: 1 });
    await this._rebuildRedisIfNeeded();
  }

  seq(convId) { return nextSeq(this.redis, convId, this.batcher); }

  async ingest({ ulid, convId, senderId, contentType, payload, ts, replyTo, ttl, fwd, imported, source, media }) {
    // Task 0.1: no upfront findOne — duplicate key catch handles it.
    // Seq gaps on duplicate are acceptable (clients require only monotonicity).
    const seq = await this.seq(convId);
    const doc = { _id: ulid, convId, seq, senderId, contentType, payload, ts, status: 1 };
    if (replyTo) doc.replyTo = replyTo;
    if (ttl) doc.ttl = ttl;
    if (fwd) doc.fwd = fwd;
    if (imported) doc.imported = true;
    if (source) doc.source = source;
    if (media) doc.media = media;
    try { await this.col.insertOne(doc); }
    catch (e) {
      if (e.code === 11000) {
        const w = await this.col.findOne({ _id: ulid }, { projection: { seq: 1, ts: 1 } });
        return { seq: w.seq, ts: w.ts, duplicate: true };
      }
      throw e;
    }
    // Task 0.2: sorted-set cache (ULID member + companion hash)
    await this._cacheMsg(convId, seq, doc);
    return { seq, ts, duplicate: false };
  }

  async _cacheMsg(convId, seq, doc) {
    const pipe = this.redis.pipeline();
    pipe.zadd(CACHE_KEY(convId), seq, doc._id);
    pipe.hset(DOCS_KEY(convId), doc._id, JSON.stringify(doc));
    pipe.zremrangebyrank(CACHE_KEY(convId), 0, -(CACHE_MAX + 1));
    await pipe.exec();
  }

  // Patch the companion hash for a doc that was mutated (delete / edit / expire).
  // Patch fields are applied over the cached JSON — avoids a MongoDB read.
  async updateCachedDoc(convId, ulid, patchFields, unsetFields) {
    const raw = await this.redis.hget(DOCS_KEY(convId), ulid);
    if (!raw) return;
    const doc = JSON.parse(raw);
    if (patchFields) Object.assign(doc, patchFields);
    if (unsetFields) for (const f of unsetFields) delete doc[f];
    await this.redis.hset(DOCS_KEY(convId), ulid, JSON.stringify(doc));
  }

  async rangeFromCache(convId, fromSeq, limit = 200) {
    const ulids = await this.redis.zrangebyscore(CACHE_KEY(convId), fromSeq + 1, '+inf', 'LIMIT', 0, limit);
    if (!ulids.length) return [];
    const jsons = await this.redis.hmget(DOCS_KEY(convId), ...ulids);
    return jsons.filter(Boolean).map((j) => JSON.parse(j));
  }

  async range(convId, fromSeq, limit = 200) {
    return this.col.find({ convId, seq: { $gt: fromSeq } }).sort({ seq: 1 }).limit(limit).toArray();
  }
  async maxSeq(convId) {
    const top = await this.col.find({ convId }).sort({ seq: -1 }).limit(1).next();
    return top ? top.seq : 0;
  }
  async getByUlid(ulid) { return this.col.findOne({ _id: ulid }); }

  // Task 0.8: buffered bulkWrite for receipt cursors (200ms window)
  async setCursor(deviceId, convId, kind, seq, userId) {
    const key = `${deviceId}:${convId}:${kind}`;
    const existing = this._cursorBuffer.get(key);
    if (existing && existing.seq >= seq) return;
    this._cursorBuffer.set(key, { deviceId, convId, kind, seq, userId });
    if (!this._cursorTimer) {
      this._cursorTimer = setTimeout(() => this._flushCursors(), CURSOR_FLUSH_MS);
    }
  }
  async getCursors(deviceId) { return this.cursors.find({ deviceId }).toArray(); }

  async _flushCursors() {
    this._cursorTimer = null;
    if (!this._cursorBuffer.size) return;
    const entries = [...this._cursorBuffer.values()];
    this._cursorBuffer.clear();
    const ops = entries.map(({ deviceId, convId, kind, seq, userId }) => {
      const field = kind === 2 ? 'readSeq' : 'deliveredSeq';
      return {
        updateOne: {
          filter: { deviceId, convId },
          update: { $max: { [field]: seq }, $set: userId ? { userId } : {}, $setOnInsert: { deviceId, convId } },
          upsert: true,
        },
      };
    });
    await this.cursors.bulkWrite(ops, { ordered: false });
  }

  async edit({ targetUlid, convId, editorId, newPayload, editTs }) {
    const seq = await this.seq(convId);
    const r = await this.col.updateOne({ _id: targetUlid, convId },
      { $set: { payload: newPayload, edited: true, editTs, editSeq: seq }, $push: { editHistory: { ts: editTs, by: editorId } } });
    if (r.matchedCount === 0) return null;
    await this.updateCachedDoc(convId, targetUlid, { payload: newPayload, edited: true, editTs, editSeq: seq });
    return { seq };
  }
  async deleteForEveryone({ targetUlid, convId, deleterId, ts }) {
    const seq = await this.seq(convId);
    const r = await this.col.updateOne({ _id: targetUlid, convId },
      { $set: { deleted: true, deletedBy: deleterId, deleteTs: ts, deleteSeq: seq }, $unset: { payload: '' } });
    if (r.matchedCount === 0) return null;
    await this.updateCachedDoc(convId, targetUlid, { deleted: true, deletedBy: deleterId, deleteTs: ts, deleteSeq: seq }, ['payload']);
    return { seq };
  }
  async react({ targetUlid, convId, userId, emoji, op }) {
    const target = await this.col.findOne({ _id: targetUlid, convId }, { projection: { _id: 1 } });
    if (!target) return null;
    const seq = await this.seq(convId);
    const update = op === 1 ? { $set: { [`reactions.${userId}`]: emoji } } : { $unset: { [`reactions.${userId}`]: '' } };
    await this.col.updateOne({ _id: targetUlid, convId }, update);
    return { seq };
  }

  // Task 0.3: membership — Redis hot set + write-through to conversations collection
  async members(convId) { return this.redis.smembers(`conv:${convId}:members`); }
  async isMember(convId, u) { return (await this.redis.sismember(`conv:${convId}:members`, u)) === 1; }
  async memberCount(convId) { return this.redis.scard(`conv:${convId}:members`); }
  async addMember(convId, u) {
    await this.redis.sadd(`conv:${convId}:members`, u);
    await this.redis.sadd(`user:${u}:convs`, convId);
    await this.convs.updateOne({ _id: convId }, { $addToSet: { members: u } }, { upsert: true });
  }
  async removeMember(convId, u) {
    await this.redis.srem(`conv:${convId}:members`, u);
    await this.redis.srem(`user:${u}:convs`, convId);
    await this.convs.updateOne({ _id: convId }, { $pull: { members: u } });
  }
  async getConvsForUser(userId) {
    return this.redis.smembers(`user:${userId}:convs`);
  }
  async isAdmin(convId, u) { return (await this.redis.sismember(`conv:${convId}:admins`, u)) === 1; }
  async setAdmin(convId, u, on) {
    if (on) {
      await this.redis.sadd(`conv:${convId}:admins`, u);
      await this.convs.updateOne({ _id: convId }, { $addToSet: { admins: u } }, { upsert: true });
    } else {
      await this.redis.srem(`conv:${convId}:admins`, u);
      await this.convs.updateOne({ _id: convId }, { $pull: { admins: u } });
    }
  }

  async groupEvent({ convId, op, actorId, target, ts, ulid }) {
    const seq = await this.seq(convId);
    await this.col.insertOne({ _id: ulid, convId, seq, senderId: actorId, contentType: 7, system: { op, target }, ts, status: 1 });
    return { seq };
  }

  /** Per-USER (multi-device) receipt aggregation.
   *  Merges in-flight cursor buffer so callers see current state immediately. */
  async receiptAgg(convId, seq) {
    const members = await this.members(convId);
    const total = members.length;
    const memberSet = new Set(members);
    const curs = await this.cursors.find({ convId }).toArray();

    // Merge buffered (not yet flushed) cursor updates for this conversation
    const curMap = new Map(curs.map((c) => [`${c.deviceId}:${c.convId}`, c]));
    for (const entry of this._cursorBuffer.values()) {
      if (entry.convId !== convId) continue;
      const bk = `${entry.deviceId}:${entry.convId}`;
      const ex = curMap.get(bk) || { deviceId: entry.deviceId, convId };
      const field = entry.kind === 2 ? 'readSeq' : 'deliveredSeq';
      curMap.set(bk, { ...ex, [field]: Math.max(ex[field] || 0, entry.seq), userId: entry.userId || ex.userId });
    }

    const perUser = new Map();
    for (const c of curMap.values()) {
      if (!c.userId || !memberSet.has(c.userId)) continue;
      const isRead = (c.readSeq || 0) >= seq;
      const isDelivered = isRead || (c.deliveredSeq || 0) >= seq;
      const cur = perUser.get(c.userId) || { delivered: false, read: false };
      cur.delivered = cur.delivered || isDelivered; cur.read = cur.read || isRead;
      perUser.set(c.userId, cur);
    }
    let delivered = 0, read = 0;
    for (const v of perUser.values()) { if (v.delivered) delivered++; if (v.read) read++; }
    return { delivered, read, total };
  }

  async rebuildSeq() {
    const agg = await this.col.aggregate([{ $group: { _id: '$convId', m: { $max: '$seq' } } }]).toArray();
    const pipe = this.redis.pipeline();
    for (const { _id, m } of agg) pipe.set(`conv:${_id}:seq`, m);
    await pipe.exec();
    if (this.batcher) for (const { _id } of agg) this.batcher.evict(_id);
    return agg.length;
  }

  // Task 0.6: auto-rebuild Redis membership + seq from MongoDB on cold start
  async _rebuildRedisIfNeeded() {
    const convDocs = await this.convs.find({}, { projection: { _id: 1, members: 1, admins: 1 } }).toArray();
    if (!convDocs.length) return;
    const checkPipe = this.redis.pipeline();
    for (const conv of convDocs) checkPipe.exists(`conv:${conv._id}:members`);
    const results = await checkPipe.exec();
    const rebuildPipe = this.redis.pipeline();
    let needsRebuild = false;
    for (let i = 0; i < convDocs.length; i++) {
      const conv = convDocs[i];
      const keyExists = results[i][1] === 1;
      if (!keyExists && conv.members && conv.members.length) {
        needsRebuild = true;
        rebuildPipe.sadd(`conv:${conv._id}:members`, ...conv.members);
        if (conv.admins && conv.admins.length) {
          rebuildPipe.sadd(`conv:${conv._id}:admins`, ...conv.admins);
        }
        for (const uid of conv.members) {
          rebuildPipe.sadd(`user:${uid}:convs`, conv._id);
        }
      }
    }
    if (needsRebuild) await rebuildPipe.exec();
    await this.rebuildSeq();
  }
}

module.exports = { CoreStore };
