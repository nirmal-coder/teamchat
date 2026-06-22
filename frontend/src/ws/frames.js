import { encode, decode } from 'cbor-x'

// Frame type constants — mirrors lib/common/frames.js
export const T = {
  HELLO: 0, WELCOME: 1, SEND: 2, ACK: 3, MSG: 4,
  DELIVERED: 5, READ: 6, SYNC_REQ: 7, SYNC_GAP: 8,
  PRESENCE: 9, PING: 10, PONG: 11, RECEIPT: 12, ERR: 13,
  EDIT: 14, EDITED: 15, DELETE: 16, DELETED: 17,
  REACT: 18, REACTED: 19, TYPING: 20, TYPING_EVT: 21,
  GROUP_OP: 22, GROUP_EVT: 23, FORWARD: 24, RECEIPT_AGG: 25,
  PIN: 26, PINNED: 27, POLL: 28, POLL_CREATED: 29,
  VOTE: 30, POLL_TALLY: 31, VIEW_ONCE: 32, VIEWED: 33,
  EXPIRED: 34, CONV_TIMER: 35, TIMER_SET: 36, SUBJECT: 37, SUBJECT_SET: 38,
}

export const CT = { TEXT: 1, IMAGE: 2, VIDEO: 3, AUDIO: 4, DOC: 5, LOCATION: 6, SYSTEM: 7, POLL: 8, VIEW_ONCE: 9 }

export const CT_LABEL = { 1: 'text', 2: 'image', 3: 'video', 4: 'audio', 5: 'doc', 6: 'location', 7: 'system', 8: 'poll', 9: 'view-once' }

export const E = {
  BAD_FRAME: 400, UNAUTH: 401, NOT_MEMBER: 403, NOT_FOUND: 404,
  PAYLOAD_TOO_LARGE: 413, EDIT_WINDOW: 422, DELETE_WINDOW: 423,
  NOT_SENDER: 424, RATE_LIMITED: 429, PIN_LIMIT: 426,
  ALREADY_VIEWED: 427, BAD_POLL: 428, NOT_ADMIN: 430, INTERNAL: 500,
}

export const E_MSG = {
  400: 'Bad frame', 401: 'Unauthorized', 403: 'Not a member', 404: 'Not found',
  413: 'Payload too large', 422: 'Edit window expired (15 min)',
  423: 'Delete window expired (48.5 hr)', 424: 'Not message sender',
  429: 'Rate limited', 426: 'Pin limit reached (max 3)',
  427: 'Already viewed', 428: 'Bad poll', 430: 'Not an admin', 500: 'Internal error',
}

// Encode helpers — build positional arrays then CBOR-encode
export const mkHello    = (deviceId, token, cursors) => encode([T.HELLO, deviceId, token, cursors])
export const mkSend     = (ulid, convId, ct, payload, replyTo, ttl) => encode([T.SEND, ulid, convId, ct, payload, replyTo ?? null, ttl ?? 0])
export const mkDelivered = (convId, seq) => encode([T.DELIVERED, convId, seq])
export const mkRead     = (convId, seq) => encode([T.READ, convId, seq])
export const mkSyncReq  = (convId, fromSeq) => encode([T.SYNC_REQ, convId, fromSeq])
export const mkPresence = (userId, state) => encode([T.PRESENCE, userId, state])
export const mkPing     = (nonce) => encode([T.PING, nonce])
export const mkPong     = (nonce) => encode([T.PONG, nonce])
export const mkEdit     = (ulid, convId, targetUlid, newPayload) => encode([T.EDIT, ulid, convId, targetUlid, newPayload])
export const mkDelete   = (ulid, convId, targetUlid, scope) => encode([T.DELETE, ulid, convId, targetUlid, scope]) // scope: 0=me, 1=everyone
export const mkReact    = (ulid, convId, targetUlid, emoji, op) => encode([T.REACT, ulid, convId, targetUlid, emoji, op]) // op: 0=remove, 1=add
export const mkTyping   = (convId, state) => encode([T.TYPING, convId, state]) // state: 0=stop, 1=start
export const mkGroupOp  = (ulid, convId, op, target) => encode([T.GROUP_OP, ulid, convId, op, target])
export const mkForward  = (ulid, convId, srcUlid, ct, payload, fwdScore) => encode([T.FORWARD, ulid, convId, srcUlid, ct, payload, fwdScore])
export const mkPin      = (ulid, convId, targetUlid, on) => encode([T.PIN, ulid, convId, targetUlid, on]) // on: 0=unpin, 1=pin
export const mkPoll     = (ulid, convId, question, options, multi) => encode([T.POLL, ulid, convId, question, options, multi])
export const mkVote     = (ulid, convId, pollUlid, optionIdxs) => encode([T.VOTE, ulid, convId, pollUlid, optionIdxs])
export const mkViewOnce = (ulid, convId, targetUlid) => encode([T.VIEW_ONCE, ulid, convId, targetUlid])
export const mkConvTimer = (ulid, convId, seconds) => encode([T.CONV_TIMER, ulid, convId, seconds])
export const mkSubject  = (ulid, convId, field, value) => encode([T.SUBJECT, ulid, convId, field, value])

export const decodeFrame = (buffer) => decode(new Uint8Array(buffer))
