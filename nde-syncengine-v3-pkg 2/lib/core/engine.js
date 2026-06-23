'use strict';
/**
 * Core engine — the always-on messaging spine: send/ingest, reconnect
 * convergence (replay), edit, delete-for-everyone, reactions, forwarding,
 * and group membership ops. Optional features (pin/poll/...) are mixed in
 * by the composer in lib/index.js.
 */
const F = require('../common/frames');
const { ensure, requireMember, requireTarget } = require('../common/errors');

const LIVE_MAX = 100;
const EDIT_WINDOW_MS = 15 * 60 * 1000;

// Normalize payload from MongoDB/Redis cache back to a plain Buffer for CBOR encoding.
// MongoDB returns bson.Binary; Redis cache stores JSON.stringify'd Buffer as {type,data}.
// Both must be converted to Uint8Array/Buffer before CBOR encodes the MSG frame.
function normalizePayload(p) {
  if (!p || p instanceof Uint8Array) return p                         // already correct
  if (p.buffer instanceof Uint8Array)                                 // bson.Binary
    return p.buffer.slice(0, p.position ?? p.buffer.length)
  if (p.type === 'Buffer' && Array.isArray(p.data))                   // JSON.parse'd Buffer
    return Buffer.from(p.data)
  return p
}
const DELETE_WINDOW_MS = 2 * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000;
const FWD_LIMIT = 5;

class CoreEngine {
  constructor({ storage }) { this.storage = storage; }

  async onHello(session, cursors) {
    const interested = [];
    for (const { convId, lastSeq } of cursors) {
      interested.push(convId);
      const maxSeq = Number(await session.redis.get(`conv:${convId}:seq`)) || 0;
      const gap = maxSeq - lastSeq;
      if (gap <= 0) continue;
      if (gap > LIVE_MAX) { session.send(F.syncGap(convId, lastSeq, maxSeq, 1)); continue; }
      await this._replay(session, convId, lastSeq);
    }
    return interested;
  }

  async onSyncReq(session, convId, fromSeq) {
    const maxSeq = Number(await session.redis.get(`conv:${convId}:seq`)) || 0;
    if (maxSeq - fromSeq > LIVE_MAX) { session.send(F.syncGap(convId, fromSeq, maxSeq, 1)); return; }
    await this._replay(session, convId, fromSeq);
  }

  async _replay(session, convId, fromSeq) {
    let cursor = fromSeq;
    for (;;) {
      // Task 0.2: try Redis sorted set cache first; fall through to MongoDB if cold
      let batch = typeof this.storage.rangeFromCache === 'function'
        ? await this.storage.rangeFromCache(convId, cursor, 200) : [];
      if (batch.length === 0) batch = await this.storage.range(convId, cursor, 200);
      if (batch.length === 0) break;
      for (const m of batch) {
        if (m.deleted) session.send(F.deleted(convId, m.deleteSeq || m.seq, m._id, m.deletedBy, m.deleteTs || m.ts));
        else if (m.expired) session.send(F.expired(convId, m.expireSeq || m.seq, m._id, m.ts));
        else {
          const meta = (m.edited || m.replyTo || m.ttl || m.fwd)
            ? { edited: !!m.edited, replyTo: m.replyTo || null, ttl: m.ttl || 0, fwd: m.fwd || 0 } : null;
          session.send(F.msg(convId, m.seq, m._id, m.senderId, m.contentType, normalizePayload(m.payload), m.ts, meta));
        }
        cursor = Math.max(cursor, m.seq, m.editSeq || 0, m.deleteSeq || 0, m.expireSeq || 0, m.pinSeq || 0);
      }
      if (batch.length < 200) break;
    }
  }

  async ingest({ ulid, convId, senderId, contentType, payload, ts, replyTo, ttl, fwd }) {
    await requireMember(this.storage, convId, senderId);
    const r = await this.storage.ingest({ ulid, convId, senderId, contentType, payload, ts, replyTo, ttl, fwd });
    const ackFrame = F.ack(ulid, convId, r.seq, r.ts);
    if (r.duplicate) return { ackFrame, msgFrame: null, seq: r.seq, ts: r.ts };
    const meta = (replyTo || ttl || fwd) ? { replyTo: replyTo || null, ttl: ttl || 0, fwd: fwd || 0 } : null;
    const msgFrame = F.msg(convId, r.seq, ulid, senderId, contentType, payload, r.ts, meta);
    return { ackFrame, msgFrame, seq: r.seq, ts: r.ts };
  }

  async edit({ convId, targetUlid, editorId, newPayload, ts }) {
    const target = await requireTarget(this.storage, convId, targetUlid);
    ensure(target.senderId === editorId, F.E.NOT_SENDER, 'can only edit own messages');
    ensure(ts - target.ts <= EDIT_WINDOW_MS, F.E.EDIT_WINDOW, 'edit window expired');
    const r = await this.storage.edit({ targetUlid, convId, editorId, newPayload, editTs: ts });
    ensure(r, F.E.NOT_FOUND, 'message not found');
    return { frame: F.edited(convId, r.seq, targetUlid, newPayload, ts, editorId), seq: r.seq };
  }

  async deleteForEveryone({ convId, targetUlid, deleterId, ts }) {
    const target = await requireTarget(this.storage, convId, targetUlid, { allowDeleted: true });
    const isAdmin = await this.storage.isAdmin(convId, deleterId);
    ensure(target.senderId === deleterId || isAdmin, F.E.NOT_SENDER, 'can only delete own messages');
    if (target.senderId === deleterId) ensure(ts - target.ts <= DELETE_WINDOW_MS, F.E.DELETE_WINDOW, 'delete window expired');
    const r = await this.storage.deleteForEveryone({ targetUlid, convId, deleterId, ts });
    ensure(r, F.E.NOT_FOUND, 'message not found');
    return { frame: F.deleted(convId, r.seq, targetUlid, deleterId, ts), seq: r.seq };
  }

  async react({ convId, targetUlid, userId, emoji, op, ts }) {
    await requireMember(this.storage, convId, userId);
    const r = await this.storage.react({ targetUlid, convId, userId, emoji, op, ts });
    ensure(r, F.E.NOT_FOUND, 'message not found');
    return { frame: F.reacted(convId, r.seq, targetUlid, userId, emoji, op), seq: r.seq };
  }

  async forward({ ulid, convId, senderId, contentType, payload, fwdScore, ts }) {
    ensure(fwdScore <= FWD_LIMIT, F.E.FWD_LIMIT, 'forward limit exceeded');
    return this.ingest({ ulid, convId, senderId, contentType, payload, ts, fwd: fwdScore });
  }

  async groupOp({ convId, op, actorId, target, ts, ulid }) {
    const actorIsAdmin = await this.storage.isAdmin(convId, actorId);
    if (op === 5) { await this.storage.removeMember(convId, actorId); }
    else if (op === 1) {
      if (target === actorId) {
        // Self-join: idempotent if already a member; bootstrap new conv as first admin
        const alreadyMember = await this.storage.isMember(convId, actorId);
        if (!alreadyMember) {
          const count = await this.storage.memberCount(convId);
          ensure(count === 0, F.E.NOT_MEMBER, 'not a member of this conversation');
          await this.storage.addMember(convId, actorId);
          await this.storage.setAdmin(convId, actorId, true);
        }
      } else {
        ensure(actorIsAdmin, F.E.NOT_MEMBER, 'admin required to add');
        await this.storage.addMember(convId, target);
      }
    }
    else if (op === 2) { ensure(actorIsAdmin, F.E.NOT_MEMBER, 'admin required to remove'); await this.storage.removeMember(convId, target); }
    else if (op === 3) { ensure(actorIsAdmin, F.E.NOT_MEMBER, 'admin required to promote'); await this.storage.setAdmin(convId, target, true); }
    else if (op === 4) { ensure(actorIsAdmin, F.E.NOT_MEMBER, 'admin required to demote'); await this.storage.setAdmin(convId, target, false); }
    else ensure(false, F.E.BAD_FRAME, 'unknown group op');
    const r = await this.storage.groupEvent({ convId, op, actorId, target, ts, ulid });
    return { frame: F.groupEvt(convId, r.seq, op, actorId, target || null, ts), seq: r.seq };
  }
}

module.exports = { CoreEngine, LIVE_MAX, EDIT_WINDOW_MS, DELETE_WINDOW_MS, FWD_LIMIT };
