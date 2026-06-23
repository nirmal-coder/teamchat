# Offline Message Persistence & Sort Fix

## Problem

Two related bugs when the server is down while sending a message:

1. **Wrong sort position** — pending message appears at the TOP of chat instead of the bottom
2. **Message lost after server restart** — pending message disappears; never retransmitted

## Root Causes

### Bug 1: seq = -Date.now() sorts to the front

`sendMessage` sets `seq: -Date.now()` (a very large negative number like -1750000000000).
`_binaryInsert` sorts ascending by seq. Negative values sort BEFORE all real seqs (1, 2, 3...).
The array is rendered left-to-right, so pending messages appear at the TOP.

### Bug 2: negative seq is outside IDB recovery range

`IdbStore.getMessages(convId, 0)` uses `IDBKeyRange.bound([convId, 0], [convId, Infinity])`.
Pending messages with seq = -Date.now() are below 0 — the range doesn't include them.
So even though `_insertMsg` writes them to IDB immediately, `_loadFromIdb` on next startup
can't find them. OutQueue is in-memory only, so it's empty after page refresh.
Result: pending message exists in IDB but at an unreachable negative key, and the OutQueue
entry to retransmit it is gone.

## Fix

### Change 1: Use large positive seq for pending messages

Instead of `-Date.now()`, use a monotonically increasing counter starting at `Date.now()`
(~1.75 × 10¹²). Real server seqs start at 1 and increment slowly — they'll never reach
this range in practice.

Benefits:
- Large positive seq sorts AFTER all real messages → appears at BOTTOM of chat ✓
- seq > 0, so `getMessages(convId, 0)` loads it from IDB on startup ✓
- Messages ordered correctly among themselves (counter is monotonic) ✓

In `sendMessage`:
```js
// Lazy-initialize once per session; Date.now() puts it >> any real server seq
if (!this._pendingSeq) this._pendingSeq = Date.now()
const pendingSeq = this._pendingSeq++
```

### Change 2: Fix lastMsg update on seq promotion

`_insertMsg` has a `if (msg.seq > 0)` guard that now also applies to pending messages
(since `Date.now() > 0`). When a pending message is first inserted, it correctly sets
conv.lastMsg (sidebar shows the pending message). But when the real MSG arrives and promotes
seq from 1.75e12 → 43, the bottom check `43 > 1.75e12` is false — lastMsg never updates.

Fix: in the promotion path (when `oldSeq !== msg.seq`), explicitly update lastMsg if the
old entry was the conv's tracked lastMsg.

### Change 3: Recover pending messages into OutQueue on startup

In `_loadFromIdb`, after loading each conv's messages from IDB, scan for any with
`status === 'pending'` and reconstruct their SEND frame from stored data:

```js
if (msg.status === 'pending' && msg.contentType === CT.TEXT && msg.payload) {
  const buf = mkSend(msg.ulid, conv.convId, CT.TEXT, textEnc.encode(msg.payload),
                     msg.replyTo ?? null, msg.ttl ?? 0)
  this._outQueue.push(msg.ulid, buf, msg.ts)
}
```

When WS connects, `_onStatus('open')` drains OutQueue → pending messages are sent →
server ACKs → status changes to 'sent' → MSG arrives → seq promoted.

### Change 4: IDB migration — drop orphaned negative-seq messages

Bump `DB_VERSION` to 4 in `IdbStore.js`. Migration deletes the messages store and recreates
it. This clears the orphaned negative-seq messages that can never be recovered (their
OutQueue frames are gone), and avoids the 30-day accumulation of unreachable IDB records.

## Files to Change

| File | Change |
|---|---|
| `frontend/src/sdk/SyncClient.js` | `sendMessage`: pending seq → large positive monotonic counter |
| `frontend/src/sdk/SyncClient.js` | `_insertMsg`: fix lastMsg on promotion |
| `frontend/src/sdk/SyncClient.js` | `_loadFromIdb`: recover pending msgs into OutQueue |
| `frontend/src/sdk/IdbStore.js` | Bump DB_VERSION to 4, clear messages store in migration |

## WhatsApp-style behavior after fix

1. User sends message while server is down → shows at BOTTOM with ● (pending)
2. Server stays down, user closes tab → message persisted in IDB
3. User reopens tab → pending message re-loaded from IDB, shows at bottom with ●
4. WS connects → OutQueue drains → message sent → server ACKs → shows ✓
5. If server is still down, message stays ● until connection is restored

## Limitations

- Only TEXT messages are recovered (no binary frames for media/polls stored)
- OutQueue TTL is 24h — messages older than that are dropped on reconnect (same as WhatsApp offline limit)
- Old negative-seq pending messages from before this fix are cleared by the IDB migration
