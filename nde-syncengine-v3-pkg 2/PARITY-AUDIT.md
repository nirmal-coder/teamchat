# NDE Sync Engine — WhatsApp Engine Parity Audit

Engine-level only (server sync/messaging logic). Excludes client-rendering,
media transcoding, E2E crypto (Signal protocol), and calls/status which are
separate subsystems.

## Coverage matrix

| WhatsApp engine feature | Status | Where | Tests |
|---|---|---|---|
| Per-conversation ordered delivery (server seq) | ✅ | storage.nextSeq, engine | 1, 25, 27 |
| At-least-once + idempotent send (dedup on ULID) | ✅ | storage.ingest | 2, 26 |
| Multi-device sync cursors | ✅ | storage.cursors, setCursor | 23 |
| Reconnect convergence + gap fill | ✅ | engine.onHello/_replay | 4, 28 |
| Cold-start REST handoff (large gap) | ✅ | engine LIVE_MAX | 4 |
| Delivered / read receipts | ✅ | gateway _onReceipt | — |
| Group receipt aggregation (per-user, multi-device) | ✅ FIXED | storage.receiptAgg | 12, 23 |
| Typing indicators | ✅ | frames TYPING/TYPING_EVT | — |
| Presence (online/offline) | ✅ | gateway presence keys | — |
| Message edit + 15-min window | ✅ | engine.edit | 5 |
| Delete-for-everyone + window + admin override | ✅ | engine.deleteForEveryone | 6 |
| Reactions (one per user) | ✅ | engine.react | 7 |
| Reply / quote | ✅ | ingest meta.replyTo | 8 |
| Forwarding + forward-limit + frequently-forwarded score | ✅ | engine.forward | 10 |
| Group membership ops + permissions + system messages | ✅ | engine.groupOp | 11 |
| Crash recovery (rebuild seq from durable store) | ✅ | storage.rebuildSeq | 14 |
| Binary/unicode/empty payload integrity | ✅ | CBOR protocol | 13 |
| **Pinned messages (max 3)** | 🆕 ADDED | engine.pin | 16 |
| **Polls + server-side vote tally** | 🆕 ADDED | engine.createPoll/vote | 17, 18 |
| **View-once media (consume once)** | 🆕 ADDED | engine.viewOnce | 19 |
| **Disappearing messages — server expiry sweep** | 🆕 ADDED | engine.sweep | 20 |
| **Per-conversation disappearing default timer** | 🆕 ADDED | engine.setConvTimer | 21 |
| **Group subject / description changes** | 🆕 ADDED | engine.setSubject | 22 |
| Disappearing TTL passthrough to client | ✅ | ingest meta.ttl | 9, 24 |

## What was added in this round
Six genuine engine-level WhatsApp features that were missing, plus one fix:

1. **Pinned messages** — pin/unpin with the WhatsApp cap of 3 per chat, ordered
   PINNED events, slot freed on unpin. Negative cases: limit, non-member,
   missing target.
2. **Polls with server-side tallying** — single- and multi-select, vote
   replacement, retraction, validated option indexes. The server is the source
   of truth for the tally (clients never compute it).
3. **View-once media** — exactly-once consumption; payload purged server-side
   after the first view; second view rejected.
4. **Server-side disappearing-message sweep** — previously TTL was only passed
   to clients; now the engine actually tombstones expired messages, broadcasts
   EXPIRED, and replays the tombstone on reconnect. Idempotent.
5. **Per-conversation disappearing default timer** — set a chat-wide timer that
   new messages inherit.
6. **Group subject/description** — admin-only, emitted as ordered system
   messages so they appear in-line on sync.

**Fix:** group receipt aggregation now aggregates **per user across devices**
(a user counts as read if any of their devices read), and ignores cursors from
non-members. The previous version keyed on deviceId and double-counted.

## Deliberately out of scope (not engine-level)
- E2E encryption (Signal double-ratchet) — crypto layer, sits above this engine.
- Media upload/transcode/thumbnails — handled by @nde/upload + storage tier.
- Voice/video calls (Mediasoup) — separate WebRTC subsystem.
- Status/Stories — separate ephemeral-broadcast product.
- Starred messages, chat archive, mute — client-local state, no engine role.
- Communities/announcement groups — composition over the existing group ops.

## Test totals
- protocol.test.js — 9 checks (wire codec, ULID monotonicity, convergence)
- features.test.js — 38 checks (round-1 parity, positive + negative)
- features2.test.js — 35 checks (round-2 added features, positive + negative)
- concurrency.test.js — 6 checks (sequence monotonicity, idempotency races, order under interleave)
- gateway.test.js — 10 checks (end-to-end over real WebSockets: SEND, POLL, VOTE, PIN, CONV_TIMER, SUBJECT, VIEW_ONCE, receipts, + negative cases)
- perf.test.js — 6 checks (SeqBatcher round-trip reduction, conv-index O(interested) delivery, throughput sanity)

**Total: 104 checks, 0 failing.** Run with `npm test`.

## Wire reachability
All round-2 features are now dispatched in the gateway's `_onFrame` switch
(PIN, POLL, VOTE, VIEW_ONCE, CONV_TIMER, SUBJECT) and validated end-to-end in
gateway.test.js against a real `ws` server. Each goes through `_guard` so an
EngineError returns an ERR frame to the sender instead of dropping the socket.
