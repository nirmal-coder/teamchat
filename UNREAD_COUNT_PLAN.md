# Unread Count — Architecture Plan

> Client-side only. No protocol changes. No server round-trips for unread state.
> 4 files changed, 1 new file, O(1) per conversation.

---

## What Is Broken Right Now

### 1. `getUnread()` — O(n) scan on loaded messages only

```js
// SyncClient.js (current — WRONG)
getUnread(convId) {
  const conv = this.conversations.get(convId)
  if (!conv) return 0
  const cursor = conv.lastReadSeq ?? 0
  return (this._msgArrays.get(convId) ?? [])
    .filter(m => m.seq > cursor && m.seq > 0 && m.senderId !== this.userId)
    .length  // ❌ only counts messages loaded in memory, wrong for large convs
}
```

**Problem:** If a conv has 5000 messages but only the last 200 are loaded, this returns 0 even when hundreds are unread above the scroll window.

### 2. `sendRead()` — never emits React-visible events

```js
// SyncClient.js (current — WRONG)
sendRead(convId, seq) {
  this._wsc.send(mkRead(convId, seq))
  this._upsertConv(convId, { lastReadSeq: seq })
  if (this._idb) this._idb.setCursor(convId, seq).catch(() => {})
  // ❌ MISSING: this.emit(`conv:${convId}`) and this.emit('conv:list')
}
```

**Problem:** `useNdeUnread` subscribes to `conv:{convId}` — it never fires. Badge stays on screen even after the user reads the conversation.

### 3. ACK — own messages count as unread

When you send a message, `lastSeq` advances on ACK but `lastReadSeq` doesn't. Result: badge = 1 for your own message.

### 4. RECEIPT echo — cross-device reads are ignored

When user reads on their phone, server broadcasts RECEIPT to all devices. The RECEIPT handler only updates delivery status on sent messages — it never advances `lastReadSeq`, so the desktop badge stays stale indefinitely.

---

## Why O(1) Is the Right Model

The server already tracks the highest sequence number per conversation (`lastSeq`).
Each device already tracks how far the user has read (`lastReadSeq`).
Unread count = their difference. One integer subtraction. Never a message scan.

```
unreadCount = Math.max(0, lastSeq - lastReadSeq)
```

**Why this works for unloaded messages:** `lastSeq` comes from MSG and ACK frames regardless of pagination — it is always current. `lastReadSeq` is sent as a READ frame and persisted in IDB. Neither needs the message payload to be in memory.

**Acceptable approximation:** If messages have been deleted, seq has gaps and the count may be 1–2 higher than the actual message count. This matches WhatsApp/Telegram behaviour — exact counts are not worth the cost of a message-level scan.

---

## Four Targeted Changes

### Change 1 — Replace `getUnread()` with O(1) seq diff

**File:** `frontend/src/sdk/SyncClient.js` ~line 176

```js
// BEFORE (wrong)
getUnread(convId) {
  const conv = this.conversations.get(convId)
  if (!conv) return 0
  const cursor = conv.lastReadSeq ?? 0
  return (this._msgArrays.get(convId) ?? [])
    .filter(m => m.seq > cursor && m.seq > 0 && m.senderId !== this.userId)
    .length
}

// AFTER (correct)
getUnread(convId) {
  const conv = this.conversations.get(convId)
  if (!conv) return 0
  return Math.max(0, (conv.lastSeq ?? 0) - (conv.lastReadSeq ?? 0))
}
```

---

### Change 2 — `sendRead()` must emit events

**File:** `frontend/src/sdk/SyncClient.js` ~line 703

```js
sendRead(convId, seq) {
  this._wsc.send(mkRead(convId, seq))
  this._upsertConv(convId, { lastReadSeq: seq })
  if (this._idb) this._idb.setCursor(convId, seq).catch(() => {})
  // ADD THESE TWO LINES:
  this.emit(`conv:${convId}`)   // wakes useNdeUnread for this conv
  this.emit('conv:list')         // wakes useNdeTotalUnread
}
```

---

### Change 3 — Advance `lastReadSeq` on ACK (own messages)

**File:** `frontend/src/sdk/SyncClient.js` — `T.ACK` case ~line 249

```js
case T.ACK: {
  const [ulid_, convId, seq, serverTs] = fields
  // ... existing: remove from outQueue, patch ts/status ...
  this._upsertConv(convId, { lastSeq: seq })

  // ADD: own message — advance read cursor so count stays 0
  const conv = this.conversations.get(convId)
  if ((conv?.lastReadSeq ?? 0) < seq) {
    this._upsertConv(convId, { lastReadSeq: seq })
  }
  this.emit(`conv:${convId}`)
  this.emit('conv:list')
  break
}
```

---

### Change 4 — Handle RECEIPT echo for cross-device sync

**File:** `frontend/src/sdk/SyncClient.js` — `T.RECEIPT` case ~line 327

```js
case T.RECEIPT: {
  const [convId, seq, receiptUserId, kind] = fields
  // ... existing: update delivery status on own sent messages ...

  // ADD: if WE read on another device, advance local cursor
  if (kind === 2 && receiptUserId === this.userId) {
    const conv = this.conversations.get(convId)
    if ((conv?.lastReadSeq ?? 0) < seq) {
      this._upsertConv(convId, { lastReadSeq: seq })
      this.emit(`conv:${convId}`)
      this.emit('conv:list')
    }
  }
  break
}
```

---

## Hook Contracts

### `useNdeUnread(convId)` — existing, verify it matches this

**File:** `frontend/src/hooks/useNdeUnread.js`

```js
export function useNdeUnread(convId) {
  const client = useNdeClient()
  const subscribe = useCallback((notify) => {
    client.on(`conv:${convId}`, notify)
    return () => client.off(`conv:${convId}`, notify)
  }, [client, convId])

  return useSyncExternalStore(
    subscribe,
    () => client.getUnread(convId),  // O(1) after Change 1
    () => 0,
  )
}
// Fires when: new MSG arrives, sendRead called, ACK received, cross-device RECEIPT
```

### `useNdeTotalUnread()` — new file

**File:** `frontend/src/hooks/useNdeTotalUnread.js`

```js
import { useCallback } from 'react'
import { useSyncExternalStore } from 'react'
import { useNdeClient } from './useNdeClient.js'

export function useNdeTotalUnread() {
  const client = useNdeClient()
  const subscribe = useCallback((notify) => {
    client.on('conv:list', notify)
    return () => client.off('conv:list', notify)
  }, [client])

  return useSyncExternalStore(
    subscribe,
    () => {
      let total = 0
      for (const conv of client.conversations.values()) {
        // skip muted convs if you add a prefs system later
        total += client.getUnread(conv.convId)
      }
      return total
    },
    () => 0,
  )
}
// Use for: browser tab title (5) TeamChat, header badge
```

---

## Sidebar Badge — UI Changes

**File:** `frontend/src/components/Sidebar.jsx`

### Per-conv badge in the conversation list

```jsx
import { useNdeUnread } from '../hooks/useNdeUnread.js'

// Inside the conversations.map() — add a new inner component so hook rules are followed
function ConvRow({ conv, userId, userMap, isActive, onSelect }) {
  const unread = useNdeUnread(conv.convId)
  const otherMemberId = conv.convId.startsWith('dm:')
    ? conv.members?.find(m => m !== userId)
    : null
  const displayName = conv.subject
    ?? (otherMemberId ? (userMap.get(otherMemberId) ?? otherMemberId.slice(0, 8)) : conv.convId)

  return (
    <button onClick={() => onSelect(conv.convId)}
      className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${isActive ? 'bg-[#2a3942]' : 'hover:bg-[#182229]'}`}>
      <div className="relative w-10 h-10 flex-shrink-0">
        <div className="w-10 h-10 rounded-full bg-[#2a3942] flex items-center justify-center text-sm font-bold">
          {conv.convId.startsWith('dm:') ? '👤' : (conv.subject?.[0]?.toUpperCase() ?? '#')}
        </div>
        {unread > 0 && !isActive && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] bg-green-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center px-1">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex justify-between items-baseline">
          <span className={`text-sm truncate ${unread > 0 && !isActive ? 'font-semibold text-white' : 'font-medium'}`}>
            {displayName}
          </span>
          {conv.lastMsg && (
            <span className="text-xs text-gray-500 flex-shrink-0 ml-2">
              {new Date(conv.lastMsg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>
        <div className={`text-xs truncate ${unread > 0 && !isActive ? 'text-gray-300' : 'text-gray-500'}`}>
          {conv.lastMsg
            ? (conv.lastMsg.deleted ? 'Deleted message'
              : conv.lastMsg.expired ? 'Expired message'
              : conv.lastMsg.contentType === 8 ? '📊 Poll'
              : conv.lastMsg.payload?.slice(0, 50) ?? '…')
            : 'No messages'}
        </div>
      </div>
    </button>
  )
}
```

Then in the main `Sidebar` component replace the inline `conversations.map()` with:

```jsx
{conversations.map((conv) => (
  <ConvRow
    key={conv.convId}
    conv={conv}
    userId={userId}
    userMap={userMap}
    isActive={conv.convId === activeConvId}
    onSelect={setActiveConv}
  />
))}
```

**Why extract `ConvRow`:** React hooks must be called at the top level of a component. `useNdeUnread(conv.convId)` changes per conv — calling it inside `map()` directly breaks the rules of hooks. Extracting `ConvRow` as its own component solves this cleanly.

### Document title badge (optional, easy win)

In `App.jsx` or a top-level layout component:

```jsx
import { useNdeTotalUnread } from './hooks/useNdeTotalUnread.js'
import { useEffect } from 'react'

function TitleBadge() {
  const total = useNdeTotalUnread()
  useEffect(() => {
    document.title = total > 0 ? `(${total > 99 ? '99+' : total}) TeamChat` : 'TeamChat'
  }, [total])
  return null
}
// Render <TitleBadge /> inside NdeChatProvider
```

---

## Edge Case Coverage

| Edge case | Expected behaviour | How handled |
|---|---|---|
| New conv, no messages | count = 0 | lastSeq=0, lastReadSeq=0 → diff=0 (auto) |
| User sends a message | count stays 0 | ACK handler advances lastReadSeq (Change 3) |
| Active conv, user viewing | count = 0, badge hidden | ChatPane sends sendRead + isActive suppresses badge |
| Offline inbox drain on reconnect | count = correct delta | MSG handler updates lastSeq; lastReadSeq persisted in IDB |
| Page refresh | counts correct before WS reconnects | lastReadSeq loaded from IDB |
| Read on another device | badge clears on this device | RECEIPT cross-device handler (Change 4) |
| Deleted/expired messages | count ≤ 1-2 higher than visible count | seq-diff approximation — acceptable |
| New DM, receiver has never seen conv | count = 1 on first message | GROUP_EVT creates conv with lastReadSeq=0; MSG advances lastSeq |
| Offline inbox — many messages at once | count = exact unread count | drainInbox fires all MSGs → lastSeq = highest seq |
| `lastReadSeq > lastSeq` (data anomaly) | count = 0 (never negative) | Math.max(0, …) clamp |
| 100+ conversations | no perf issue | O(1) per conv; total unread iterates conv list once (already in memory) |
| Muted conv (future) | no badge, excluded from total | check conv pref in hook before counting |

---

## Files Summary

| Action | File | Change |
|---|---|---|
| MODIFY | `frontend/src/sdk/SyncClient.js` | `getUnread` + `sendRead` emit + ACK handler + RECEIPT handler |
| MODIFY | `frontend/src/components/Sidebar.jsx` | extract `ConvRow`, add `useNdeUnread` badge |
| VERIFY | `frontend/src/hooks/useNdeUnread.js` | should already match the contract above — confirm events |
| NEW | `frontend/src/hooks/useNdeTotalUnread.js` | total across all convs, subscribes to `conv:list` |
| NEW (optional) | `TitleBadge` in `App.jsx` | document title badge |

---

## Implementation Order

1. **Change 1** — fix `getUnread()` to O(1). Test: log the result for a conv, should be `lastSeq - lastReadSeq`.
2. **Change 2** — add emits to `sendRead()`. Test: open a conv with unread messages, they should clear immediately.
3. **Change 3** — ACK advances `lastReadSeq`. Test: send a message, badge should stay 0.
4. **Change 4** — RECEIPT cross-device. Test: read on one device, badge clears on other.
5. **Sidebar badge** — `ConvRow` extraction + badge UI. Test visually.
6. **`useNdeTotalUnread`** — optional, add title badge last.
