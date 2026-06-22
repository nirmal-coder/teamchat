'use strict';
/**
 * Binary wire protocol for NDE sync engine.
 * Every frame is a CBOR-encoded array: [type, ...fields]
 * Positional arrays (not maps) to minimise bytes on the hot path.
 *
 * Frame types (uint8):
 *   0  HELLO        c->s  [0, deviceId, token, [{convId, lastSeq}, ...]]
 *   1  WELCOME      s->c  [1, serverTime, sessionId]
 *   2  SEND         c->s  [2, ulid, convId, contentType, payload, replyTo?, ttl?]
 *   3  ACK          s->c  [3, ulid, convId, seq, serverTs]
 *   4  MSG          s->c  [4, convId, seq, ulid, senderId, contentType, payload, ts, meta?]
 *                         meta = {replyTo, ttl, fwd, edited, media}
 *   5  DELIVERED    c->s  [5, convId, seq]
 *   6  READ         c->s  [6, convId, seq]
 *   7  SYNC_REQ     c->s  [7, convId, fromSeq]
 *   8  SYNC_GAP     s->c  [8, convId, fromSeq, toSeq, useRest]
 *   9  PRESENCE     c->s  [9, userId, state]            // 0 off,1 on
 *   10 PING         <->   [10, nonce]
 *   11 PONG         <->   [11, nonce]
 *   12 RECEIPT      s->c  [12, convId, seq, userId, kind] // 1 delivered 2 read
 *   13 ERR          s->c  [13, code, detail]
 *   -- extended (WhatsApp parity) --
 *   14 EDIT         c->s  [14, ulid, convId, targetUlid, newPayload]
 *   15 EDITED       s->c  [15, convId, seq, targetUlid, newPayload, editTs, editorId]
 *   16 DELETE       c->s  [16, ulid, convId, targetUlid, scope]  // scope 1=everyone
 *   17 DELETED      s->c  [17, convId, seq, targetUlid, deleterId, ts]
 *   18 REACT        c->s  [18, ulid, convId, targetUlid, emoji, op] // op 1 add,0 remove
 *   19 REACTED      s->c  [19, convId, seq, targetUlid, userId, emoji, op]
 *   20 TYPING       c->s  [20, convId, state]           // 1 start typing, 0 stop
 *   21 TYPING_EVT   s->c  [21, convId, userId, state, expiresAt]
 *   22 GROUP_OP     c->s  [22, ulid, convId, op, target] // op:1 add,2 remove,3 promote,4 demote,5 leave
 *   23 GROUP_EVT    s->c  [23, convId, seq, op, actorId, target, ts] // system message in log
 *   24 FORWARD      c->s  [24, ulid, convId, srcUlid, contentType, payload, fwdScore]
 *   25 RECEIPT_AGG  s->c  [25, convId, seq, deliveredCount, readCount, total]
 *   -- extended (WhatsApp parity, round 2) --
 *   26 PIN          c->s  [26, ulid, convId, targetUlid, on]      // on:1 pin,0 unpin
 *   27 PINNED       s->c  [27, convId, seq, targetUlid, by, on, ts]
 *   28 POLL         c->s  [28, ulid, convId, question, options[], multi]
 *   29 POLL_CREATED s->c  [29, convId, seq, ulid, by, question, options[], multi, ts]
 *   30 VOTE         c->s  [30, ulid, convId, pollUlid, optionIdxs[]] // empty = retract
 *   31 POLL_TALLY   s->c  [31, convId, seq, pollUlid, tally[], voters]
 *   32 VIEW_ONCE    c->s  [32, ulid, convId, targetUlid]
 *   33 VIEWED       s->c  [33, convId, seq, targetUlid, viewerId, ts]
 *   34 EXPIRED      s->c  [34, convId, seq, targetUlid, ts]        // server-swept disappearing msg
 *   35 CONV_TIMER   c->s  [35, ulid, convId, seconds]              // 0 = off
 *   36 TIMER_SET    s->c  [36, convId, seq, by, seconds, ts]
 *   37 SUBJECT      c->s  [37, ulid, convId, field, value]         // field: subject|description
 *   38 SUBJECT_SET  s->c  [38, convId, seq, by, field, value, ts]
 */

const cbor = require('cbor-x');
const encoder = new cbor.Encoder({ useRecords: false, tagUint8Array: false });

const T = Object.freeze({
  HELLO: 0, WELCOME: 1, SEND: 2, ACK: 3, MSG: 4, DELIVERED: 5, READ: 6,
  SYNC_REQ: 7, SYNC_GAP: 8, PRESENCE: 9, PING: 10, PONG: 11, RECEIPT: 12, ERR: 13,
  EDIT: 14, EDITED: 15, DELETE: 16, DELETED: 17, REACT: 18, REACTED: 19,
  TYPING: 20, TYPING_EVT: 21, GROUP_OP: 22, GROUP_EVT: 23, FORWARD: 24, RECEIPT_AGG: 25,
  // ---- extended WhatsApp parity (round 2) ----
  PIN: 26, PINNED: 27,           // pin / unpin a message (max 3 per chat)
  POLL: 28, POLL_CREATED: 29,    // create a poll message
  VOTE: 30, POLL_TALLY: 31,      // cast a vote -> server-aggregated tally
  VIEW_ONCE: 32, VIEWED: 33,     // view-once media consume + notify
  EXPIRED: 34,                   // server-swept disappearing message removed
  CONV_TIMER: 35, TIMER_SET: 36, // per-conversation disappearing default
  SUBJECT: 37, SUBJECT_SET: 38,  // group subject/description change
});

// content types
const CT = Object.freeze({ TEXT: 1, IMAGE: 2, VIDEO: 3, AUDIO: 4, DOC: 5, LOCATION: 6, SYSTEM: 7, POLL: 8, VIEW_ONCE: 9 });
// delete scopes
const DEL = Object.freeze({ ME: 0, EVERYONE: 1 });
// error codes
const E = Object.freeze({
  BAD_FRAME: 400, UNAUTH: 401, NOT_MEMBER: 403, NOT_FOUND: 404,
  EDIT_WINDOW: 422, DELETE_WINDOW: 423, NOT_SENDER: 424, RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413, FWD_LIMIT: 425, INTERNAL: 500,
  PIN_LIMIT: 426,        // > 3 pinned messages
  ALREADY_VIEWED: 427,   // view-once already consumed
  BAD_POLL: 428,         // malformed poll / invalid option index
  NOT_ADMIN: 430,        // group action requires admin
});

function encode(arr) { return encoder.encode(arr); }
function decode(buf) {
  const u8 = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  return encoder.decode(u8);
}

// ---- builders ----
const welcome    = (t, sid)                       => encode([T.WELCOME, t, sid]);
const ack        = (ulid, c, seq, ts)             => encode([T.ACK, ulid, c, seq, ts]);
const msg        = (c, seq, ulid, sid, ct, p, ts, meta) => encode([T.MSG, c, seq, ulid, sid, ct, p, ts, meta || null]);
const syncGap    = (c, from, to, useRest)         => encode([T.SYNC_GAP, c, from, to, useRest]);
const receipt    = (c, seq, uid, kind)            => encode([T.RECEIPT, c, seq, uid, kind]);
const pong       = (nonce)                        => encode([T.PONG, nonce]);
const err        = (code, detail)                 => encode([T.ERR, code, detail]);
const edited     = (c, seq, tUlid, p, ts, eid)    => encode([T.EDITED, c, seq, tUlid, p, ts, eid]);
const deleted    = (c, seq, tUlid, did, ts)       => encode([T.DELETED, c, seq, tUlid, did, ts]);
const reacted    = (c, seq, tUlid, uid, emoji, op)=> encode([T.REACTED, c, seq, tUlid, uid, emoji, op]);
const typingEvt  = (c, uid, state, expiresAt)     => encode([T.TYPING_EVT, c, uid, state, expiresAt]);
const groupEvt   = (c, seq, op, actor, target, ts)=> encode([T.GROUP_EVT, c, seq, op, actor, target, ts]);
const receiptAgg = (c, seq, d, r, total)          => encode([T.RECEIPT_AGG, c, seq, d, r, total]);
// round-2 builders
const pinned       = (c, seq, tUlid, by, on, ts)        => encode([T.PINNED, c, seq, tUlid, by, on, ts]);
const pollCreated  = (c, seq, ulid, by, question, options, multi, ts) => encode([T.POLL_CREATED, c, seq, ulid, by, question, options, multi, ts]);
const pollTally    = (c, seq, pollUlid, tally, voters)  => encode([T.POLL_TALLY, c, seq, pollUlid, tally, voters]);
const viewed       = (c, seq, tUlid, viewerId, ts)      => encode([T.VIEWED, c, seq, tUlid, viewerId, ts]);
const expired      = (c, seq, tUlid, ts)                => encode([T.EXPIRED, c, seq, tUlid, ts]);
const timerSet     = (c, seq, by, seconds, ts)          => encode([T.TIMER_SET, c, seq, by, seconds, ts]);
const subjectSet   = (c, seq, by, field, value, ts)     => encode([T.SUBJECT_SET, c, seq, by, field, value, ts]);

module.exports = {
  T, CT, DEL, E, encode, decode,
  welcome, ack, msg, syncGap, receipt, pong, err,
  edited, deleted, reacted, typingEvt, groupEvt, receiptAgg,
  pinned, pollCreated, pollTally, viewed, expired, timerSet, subjectSet,
};
