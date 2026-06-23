# Message Delivery Status — Fix Plan

> All changes are client-side (`SyncClient.js` + `MessageBubble.jsx`).
> No protocol changes. No server changes.

---

## The Status State Machine

```
pending  →  sent  →  delivered  →  read
   ●           ✓        ✓✓            ✓✓
                       (gray)        (blue)
```

Status can only advance, never go backwards. Once `read`, a message stays `read`.

---

## Bug Inventory — 6 Root Causes

### Bug 1 — T.MSG overwrites own message status with `'received'`

**File:** `SyncClient.js` line 279

```js
// Current (wrong)
const msg = {
  ...
  status: 'received',  // ← ALWAYS 'received', even for sender's own messages
  ...
}
```

**Sequence that breaks it (typical — ACK arrives before MSG):**

```
1. sendMessage()         → inserts optimistic msg { seq: -T, status: 'pending' }
2. T.ACK arrives         → _patchByUlid patches optimistic to { status: 'sent' }
3. T.MSG arrives via fanout → _insertMsg removes optimistic, inserts { seq: real, status: 'received' }
   ↑ status: 'sent' is LOST. Sender sees no tick.
```

**Also broken (MSG arrives before ACK — rare but possible):**

```
1. sendMessage()         → inserts optimistic { seq: -T, status: 'pending' }
2. T.MSG arrives first   → removes optimistic, inserts { seq: real, status: 'received' }
3. T.ACK arrives         → _patchByUlid looks up ulid → finds real seq → patches to 'sent' ✓
   ↑ This case actually works, but only by accident.
```

**Fix:** In T.MSG, check if senderId === this.userId. If yes, look up the existing message for this ulid (the optimistic entry) and carry its status forward. Default to `'sent'` (never `'received'`) for own messages.

```js
// After fix
case T.MSG: {
  const [convId, seq, ulid_, senderId, contentType, payload, ts, meta] = fields
  const text = contentType === CT.POLL ? null : payloadToText(payload)

  // Own messages: preserve status set by ACK on the optimistic entry.
  // Default to 'sent' (not 'received') so the sender always has a visible tick.
  // Other people's messages: always 'received'.
  let status = 'received'
  if (senderId === this.userId) {
    const existing = this.getMessage(convId, ulid_)
    status = existing?.status ?? 'sent'
  }

  const msg = {
    ulid: ulid_, seq, senderId, contentType,
    payload: text, rawPayload: payload, ts, meta,
    status, reactions: {},
    replyTo: meta?.replyTo ?? null, fwd: meta?.fwd ?? 0, ttl: meta?.ttl ?? 0,
    edited: false, deleted: false, expired: false,
  }
```

---

### Bug 2 — RECEIPT is a cursor but only updates one message

**File:** `SyncClient.js` lines 331–334

```js
// Current (wrong)
case T.RECEIPT: {
  const [convId, seq, receiptUserId, kind] = fields
  const msg = this.getMessageBySeq(convId, seq)      // ← only the ONE message at seq
  if (msg?.senderId === this.userId) {
    this._patchMsg(convId, seq, { status: kind === 2 ? 'read' : 'delivered' })
  }
```

**Why this is wrong:**

`RECEIPT(convId, seq, userId, kind)` means "user X has read/received up to seq N". It is a cursor, not a per-message event. The receiver reads messages 1–5 in one sitting and sends one `READ(convId, 5)` frame. The server broadcasts one `RECEIPT(convId, 5, ...)`. Only the message at seq=5 gets marked read — messages 1–4 stay at `'sent'` forever.

**Fix:** When RECEIPT arrives, walk backwards through `_msgArrays` from the receipt seq, patching all loaded messages sent by `this.userId` that still have status < the new status.

```js
// After fix
case T.RECEIPT: {
  const [convId, seq, receiptUserId, kind] = fields
  const newStatus = kind === 2 ? 'read' : 'delivered'
  const STATUS_RANK = { pending: 0, sent: 1, delivered: 2, read: 3 }
  const arr = this._msgArrays.get(convId) ?? []

  // Update all own messages up to the cursor position
  for (const m of arr) {
    if (m.seq > seq) break                            // sorted asc, done
    if (m.senderId !== this.userId) continue          // not our message
    if ((STATUS_RANK[m.status] ?? 0) >= STATUS_RANK[newStatus]) continue  // already higher
    this._patchMsg(convId, m.seq, { status: newStatus })
    this.emit(`msgstatus:${convId}:${m.ulid}`)
  }

  // Cross-device: if WE read on another device, advance local read cursor
  if (kind === 2 && receiptUserId === this.userId) {
    const receiptConv = this.conversations.get(convId)
    if ((receiptConv?.lastReadSeq ?? 0) < seq) {
      this._upsertConv(convId, { lastReadSeq: seq })
      this.emit(`conv:${convId}`)
      this.emit('conv:list')
    }
  }
  break
}
```

**Note on unloaded messages:** Messages older than the scroll window are not in `_msgArrays`. Their status in IDB remains stale. This is acceptable — those messages are not visible. If the user scrolls up and loads them, they'll render without a tick (since IDB has the old 'sent' status). A server-side cursor approach could fix this, but it's overkill for a prototype.

---

### Bug 3 — Status can go backwards (no upgrade guard)

**File:** `SyncClient.js` — both `_patchMsg` usages in RECEIPT handler

If a late `DELIVERED` receipt arrives after a `READ` receipt (out of order or replay), the message status is downgraded from `'read'` to `'delivered'`. The fix is the `STATUS_RANK` guard in Bug 2's fix above — never overwrite with a lower-ranked status.

This also protects against duplicate receipts, which are possible if the server replays them on reconnect.

---

### Bug 4 — RECEIPT_AGG stores counts but never updates message status

**File:** `SyncClient.js` lines 348–355

```js
// Current — stores the receipt aggregate but never updates status
case T.RECEIPT_AGG: {
  const [convId, seq, deliveredCount, readCount, total] = fields
  const msg = this.getMessageBySeq(convId, seq)
  if (msg) {
    this._patchMsg(convId, seq, { receiptAgg: { delivered: deliveredCount, read: readCount, total } })
    this.emit(`receipts:${convId}:${seq}`)
  }
  break
}
```

`RECEIPT_AGG` is sent for group conversations. It carries how many members have delivered/read a message. The `status` field is never updated, so group messages always show `✓` (sent) even after everyone has read them.

**Fix:** Derive status from counts. Blue ✓✓ only when ALL other members have read (`readCount >= total - 1`); `total` includes the sender, so `total - 1` = all other members. Same threshold for gray ✓✓.

```js
case T.RECEIPT_AGG: {
  const [convId, seq, deliveredCount, readCount, total] = fields
  const msg = this.getMessageBySeq(convId, seq)
  if (msg?.senderId === this.userId) {
    const STATUS_RANK = { pending: 0, sent: 1, delivered: 2, read: 3 }
    const threshold = total - 1
    const newStatus = readCount >= threshold ? 'read' : deliveredCount >= threshold ? 'delivered' : null
    const patch = { receiptAgg: { delivered: deliveredCount, read: readCount, total } }
    if (newStatus && (STATUS_RANK[msg.status] ?? 0) < STATUS_RANK[newStatus]) {
      patch.status = newStatus
    }
    this._patchMsg(convId, seq, patch)
    this.emit(`receipts:${convId}:${seq}`)
    if (patch.status) this.emit(`msgstatus:${convId}:${msg.ulid}`)
  }
  break
}
```

---

### Bug 5 — Sender sends DELIVERED for their own messages

**File:** `SyncClient.js` lines 291–298 (inside T.MSG handler)

```js
// Current — no guard, sender sends DELIVERED even for their own messages
this._deliveredSeqs[convId] = Math.max(this._deliveredSeqs[convId] || 0, seq)
clearTimeout(this._deliveredTimers[convId])
this._deliveredTimers[convId] = setTimeout(() => {
  if (this._wsStatus === 'open') {
    this._wsc.send(mkDelivered(convId, this._deliveredSeqs[convId]))
  }
  ...
}, 400)
```

When the sender receives their own MSG via fanout, they send `DELIVERED` back. The server then sends a `RECEIPT(kind=1, deliveredBy=senderId)` back to the sender — which could confuse the status machine.

**Fix:** Skip DELIVERED send for own messages:

```js
// Add this guard before the debounced DELIVERED block:
if (senderId !== this.userId) {
  this._deliveredSeqs[convId] = Math.max(this._deliveredSeqs[convId] || 0, seq)
  clearTimeout(this._deliveredTimers[convId])
  this._deliveredTimers[convId] = setTimeout(() => { ... }, 400)
}
```

---

### Bug 6 — StatusTick: `delivered` and `read` look identical

**File:** `MessageBubble.jsx` lines 11–15

```jsx
// Current — both delivered and read are blue ✓✓, only font weight differs
if (status === 'delivered') return <span className="text-blue-400 text-xs">✓✓</span>
if (status === 'read')      return <span className="text-blue-400 text-xs font-bold">✓✓</span>
```

**Fix:** Match the WhatsApp/Telegram convention: gray ✓✓ = delivered, blue ✓✓ = read. The bold variant is not enough visual distinction.

```jsx
function StatusTick({ status }) {
  if (status === 'pending')   return <span className="text-gray-600 text-xs">●</span>
  if (status === 'sent')      return <span className="text-gray-400 text-xs">✓</span>
  if (status === 'delivered') return <span className="text-gray-400 text-xs">✓✓</span>
  if (status === 'read')      return <span className="text-blue-400 text-xs">✓✓</span>
  return null
}
```

---

## Edge Case Coverage

| Edge case | Expected behaviour | How handled |
|---|---|---|
| ACK arrives before MSG | Optimistic patched to 'sent'. MSG arrives, checks existing status → carries 'sent' forward. | Bug 1 fix |
| MSG arrives before ACK | MSG inserts 'sent' (default for own). ACK arrives, patches to 'sent' again (idempotent). | Bug 1 fix (default 'sent') |
| WS drops before ACK | Message stays 'pending' in IDB. On reconnect, OutQueue resends → new ACK → 'sent'. | OutQueue (existing) |
| Receiver reads a batch (seqs 1–10 in one sitting) | RECEIPT(seq=10) arrives. Walk backwards from 10, update all own messages ≤10. | Bug 2 fix |
| Receiver never comes online (DM) | Message stays 'sent'. No RECEIPT until they reconnect. | Correct — no change needed |
| Out-of-order receipts (delivered after read) | STATUS_RANK guard prevents downgrade. 'read' stays 'read'. | Bug 3 fix |
| Group chat: 5/10 members read | RECEIPT_AGG: readCount=5. Status → 'read' (≥1 reader). receiptAgg stores exact counts. | Bug 4 fix |
| Group chat: 0/10 members read yet | RECEIPT_AGG: readCount=0, deliveredCount>0. Status → 'delivered'. | Bug 4 fix |
| Group chat: message sent, nobody online yet | No RECEIPT_AGG until first delivery. Status stays 'sent'. | Correct |
| Sender reads DELIVERED for own message | Guard skips sending DELIVERED for own messages. No spurious receipt loop. | Bug 5 fix |
| Sender is in a group and also the last reader | RECEIPT_AGG readCount increments for sender. Status would already be 'read' from ACK path. STATUS_RANK guard prevents double-update. | Bug 3 + Bug 4 |
| Messages loaded from IDB after refresh | Status from IDB is preserved (IDB was written on each `_patchMsg`). Replay from server can upgrade if needed. | Existing IDB write |
| Replica device (same user, two tabs) | RECEIPT echoed via RECEIPT frame (Bug 2 fix) + cross-device lastReadSeq logic (already fixed). | Existing + Bug 2 |
| Old messages not loaded in memory | Their status in IDB is stale. Not visible — only affects if user scrolls up to that range. Acceptable for prototype. | Known limitation |
| RECEIPT for message not in memory | `_msgArrays` walk is empty for that range. No-op. | Bug 2 fix (no crash) |
| Deleted message status | Deleted messages show "deleted" label. StatusTick still rendered but status irrelevant. | Existing |
| Very fast typist: 10 messages before ACK | All 10 have 'pending'. ACKs arrive in order. Each `_patchByUlid` patches the right optimistic entry. MSG fanout carries each status forward. | Bug 1 fix |

---

## Files to Change

| File | Changes |
|---|---|
| `frontend/src/sdk/SyncClient.js` | T.MSG: preserve status for own messages (Bug 1) |
| `frontend/src/sdk/SyncClient.js` | T.RECEIPT: cursor walk + STATUS_RANK guard (Bug 2 + 3) |
| `frontend/src/sdk/SyncClient.js` | T.RECEIPT_AGG: derive status from counts (Bug 4) |
| `frontend/src/sdk/SyncClient.js` | T.MSG: skip DELIVERED for own messages (Bug 5) |
| `frontend/src/components/MessageBubble.jsx` | StatusTick: gray ✓✓ for delivered, blue ✓✓ for read (Bug 6) |

---

## Implementation Order

1. **Bug 1** — T.MSG status preservation. Fixes the most visible symptom (own messages show no tick).
2. **Bug 5** — Skip DELIVERED for own messages. Prevents spurious receipt loop before fixing the handler.
3. **Bug 2 + 3** — RECEIPT cursor walk with STATUS_RANK guard. Fixes DM read receipts accurately.
4. **Bug 4** — RECEIPT_AGG status derivation. Fixes group chat status.
5. **Bug 6** — StatusTick visual. Polish last — behavior must be correct first.
