# @nde/syncengine-client — Implementation Plan

## 1. Gap Analysis: what already exists vs what's missing

### ✅ Exists in `src/ws/`

| File | Status | Notes |
|---|---|---|
| `frames.js` | Complete | All 38 frame types, all `mk*` builders, `decodeFrame` |
| `ulid.js` | Complete | Monotonic, browser-native |
| `WsClient.js` | Mostly complete | Connect, exponential backoff, ping/pong keepalive |

### ✅ Exists in `src/store/index.js`

All frame dispatch logic, all outbound action helpers, all optimistic insert patterns. This is the brain — but it's **Zustand-coupled** and **React-only**, can't be used in vanilla JS or other frameworks.

### ❌ Missing — gaps that block production use

| Gap | Impact |
|---|---|
| **Outbound queue** | Messages sent while WS is reconnecting are silently dropped |
| **ACK timeout** | Optimistic messages stay `pending` forever if ACK never arrives |
| **Token refresh callback** | JWT expires → reconnect silently fails (gets ERR 401) |
| **IndexedDB persistence** | No offline message cache; page reload = blank until full replay |
| **Framework-agnostic SDK class** | Logic locked inside Zustand — can't use outside React |
| **`useSyncExternalStore` hook** | Current hook pattern causes extra re-renders under concurrent mode |
| **SYNC_GAP auto-recover** | Current handler shows a toast but doesn't re-request the missing range |

---

## 2. Target folder structure

```
src/
  ws/                    ← UNCHANGED — keep exactly as-is
    frames.js
    ulid.js
    WsClient.js

  sdk/                   ← NEW — pure JS, zero React deps
    EventEmitter.js      ← tiny hand-rolled emitter (no Node dep)
    OutQueue.js          ← outbound message queue (drain on reconnect)
    IdbStore.js          ← IndexedDB persistence (messages + cursors)
    SyncClient.js        ← main SDK class — owns state + dispatch + actions
    index.js             ← re-exports { SyncClient }

  hooks/                 ← NEW — React adapter
    useNdeChat.js        ← useSyncExternalStore wrapper over SyncClient

  store/                 ← UPDATED — now thin wrapper over SyncClient
    index.js

  components/            ← UNCHANGED
    ...
```

---

## 3. Architecture diagram

```
App / any framework
       │
       │  new SyncClient({ url, getToken, idb: true })
       ▼
  ┌─────────────────────────────────────────────────────┐
  │                   SyncClient                         │
  │                                                      │
  │  state:                                              │
  │    conversations  Map<convId, ConvDoc>               │
  │    messages       Map<convId, Map<seq, MsgDoc>>      │
  │    presence       Map<userId, 'online'|'offline'>    │
  │    typing         Map<convId, Map<userId, expiresAt>>│
  │                                                      │
  │  events (EventEmitter):                              │
  │    status | message | message:edit | message:delete  │
  │    receipt | receipt:agg | typing | presence         │
  │    pinned | poll:tally | sync:gap | error | welcome  │
  │                                                      │
  │  actions:                                            │
  │    send / edit / delete / react / forward            │
  │    pin / createPoll / vote / viewOnce                │
  │    setTimer / setSubject / groupOp / subscribe       │
  └───────────────┬────────────────┬────────────────────┘
                  │                │
           ┌──────▼───────┐  ┌─────▼──────┐
           │  WsClient    │  │  IdbStore  │
           │  (transport) │  │  (offline) │
           └──────────────┘  └────────────┘
                  │
           ┌──────▼──────┐
           │  OutQueue   │
           │ (drain on   │
           │  reconnect) │
           └─────────────┘
```

---

## 4. Phase 1 — `sdk/EventEmitter.js` + `sdk/SyncClient.js`

**Goal**: Extract all frame dispatch + action logic from `store/index.js` into a plain JS class with no framework dependency.

### 4.1 `sdk/EventEmitter.js`

Tiny in-browser emitter — no Node dependency.

```js
export class EventEmitter {
  constructor() { this._listeners = new Map(); }
  on(event, fn)  { if (!this._listeners.has(event)) this._listeners.set(event, []); this._listeners.get(event).push(fn); return this; }
  off(event, fn) { const arr = this._listeners.get(event); if (arr) this._listeners.set(event, arr.filter(f => f !== fn)); }
  emit(event, ...args) { for (const fn of this._listeners.get(event) ?? []) fn(...args); }
  once(event, fn) { const w = (...a) => { this.off(event, w); fn(...a); }; this.on(event, w); }
}
```

### 4.2 `sdk/SyncClient.js` — constructor + connect

```js
export class SyncClient extends EventEmitter {
  constructor({ url, deviceId, getToken, conversations = [], idb = false }) {
    super()
    this._url       = url
    this._deviceId  = deviceId
    this._getToken  = getToken        // async () => string
    this._idb       = idb ? new IdbStore('nde-sync') : null

    // In-memory state
    this.conversations = new Map()    // convId → ConvDoc
    this.messages      = new Map()    // convId → Map<seq, MsgDoc>
    this.presence      = new Map()
    this.typing        = new Map()
    this._cursors      = new Map()    // convId → lastSeq (for HELLO)

    this._ws     = null
    this._queue  = new OutQueue()
    this._ackMap = new Map()          // ulid → { timer, resolve, reject }

    // Seed initial conversations
    for (const { convId, lastSeq } of conversations) {
      this._cursors.set(convId, lastSeq ?? 0)
      this.conversations.set(convId, { convId, subject: convId, members: [], admins: [], pins: [], timer: 0 })
    }
  }

  async connect() { /* create WsClient, pass this._onFrame, flush queue on open */ }
  destroy()       { /* close WsClient, clear timers */ }
}
```

### 4.3 Frame dispatch — extract from `store/index.js`

Move the entire `switch (type) { ... }` from store into `SyncClient._onFrame(type, fields)`.  
Instead of `set()` and `_upsertMsg()`, mutate `this.messages` / `this.conversations` and call `this.emit(...)`.

Frame → event mapping:

| Frame | Emits |
|---|---|
| `WELCOME` | `welcome` |
| `ACK` | `ack` (clears ack timer, resolves pending) |
| `MSG` | `message` |
| `EDITED` | `message:edit` |
| `DELETED` | `message:delete` |
| `REACTED` | `message:react` |
| `RECEIPT` | `receipt` |
| `RECEIPT_AGG` | `receipt:agg` |
| `TYPING_EVT` | `typing` |
| `PINNED` | `pinned` |
| `POLL_CREATED` | `message` (poll type) |
| `POLL_TALLY` | `poll:tally` |
| `VIEWED` | `message:viewed` |
| `EXPIRED` | `message:expired` |
| `TIMER_SET` | `conv:timer` |
| `SUBJECT_SET` | `conv:subject` |
| `GROUP_EVT` | `group:event` |
| `SYNC_GAP` | `sync:gap` + auto-request `SYNC_REQ` |
| `ERR` | `error` |

### 4.4 Action methods — extracted from `store/index.js`

All `mkSend`, `mkEdit`, etc. calls move from the store into `SyncClient` methods.

```js
// Returns ulid (async — waits for ACK, rejects on timeout)
send(convId, contentType, payload, { replyTo, ttl, timeoutMs = 30_000 } = {}) { ... }

edit(convId, targetUlid, newPayload)
delete(convId, targetUlid)
react(convId, targetUlid, emoji, op)
forward(convId, srcUlid, contentType, payload, fwdScore)
pin(convId, targetUlid, on)
createPoll(convId, question, options, multi)
vote(convId, pollUlid, optionIdxs)
viewOnce(convId, targetUlid)
setTimer(convId, seconds)
setSubject(convId, field, value)
groupOp(convId, op, target)
typing(convId)       // debounced: sends start, auto-sends stop after 3s
subscribe(convId)    // add to cursor list + re-send HELLO
```

### 4.5 ACK timeout (30 seconds)

```js
// Inside send():
const ackPromise = new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    this._ackMap.delete(ulid_)
    reject(Object.assign(new Error('ACK timeout'), { code: 'TIMEOUT', ulid: ulid_ }))
  }, timeoutMs)
  this._ackMap.set(ulid_, { timer, resolve, reject })
})

// In _onFrame for T.ACK:
const pending = this._ackMap.get(ackUlid)
if (pending) { clearTimeout(pending.timer); this._ackMap.delete(ackUlid); pending.resolve({ seq, ts }) }
```

---

## 5. Phase 2 — `sdk/OutQueue.js`

**Goal**: Never drop a message when WS is closed. Queue, drain on reconnect.

```js
export class OutQueue {
  constructor() {
    this._queue   = []         // [{ ulid, buf, ts }]
    this._sending = false
  }

  // Called by SyncClient._send() — adds to queue and tries to drain
  enqueue(ulid, buf)  { this._queue.push({ ulid, buf, ts: Date.now() }); }

  // Called on WS open — flushes queue through the transport
  async drain(sendFn) {
    if (this._sending) return
    this._sending = true
    while (this._queue.length) {
      const item = this._queue.shift()
      sendFn(item.buf)
    }
    this._sending = false
  }

  remove(ulid) { this._queue = this._queue.filter(i => i.ulid !== ulid); }
  size()       { return this._queue.length; }
}
```

Integration in `SyncClient`:
- `ws.onopen` → `this._queue.drain(this._ws.send.bind(this._ws))`
- Every action method calls `this._queue.enqueue(ulid, buf)` before `this._ws.send()`
- On ACK received → `this._queue.remove(ulid)` (already drained, but keeps accounting clean)
- On ACK timeout → can show error, remove from queue

---

## 6. Phase 3 — `sdk/IdbStore.js`

**Goal**: Persist messages + cursors to IndexedDB so page reload = fast restore, not blank screen.

### IDB schema

```
DB name: nde-sync
version: 1

stores:
  messages     keyPath: [convId, seq]     indexes: convId
  cursors      keyPath: convId            (value = lastSeq)
  conversations keyPath: convId
```

### API

```js
class IdbStore {
  async open()                            // open/upgrade DB
  async saveMsg(convId, seq, doc)         // put into messages store
  async getMsgs(convId, fromSeq, limit)   // getAll by convId+seq range
  async saveCursor(convId, seq)           // update cursor
  async getCursors()                      // → [{ convId, lastSeq }]
  async saveConv(conv)                    // put conversation doc
  async getConvs()                        // → ConvDoc[]
  async clear()                           // full reset (new device flow)
}
```

### Integration in SyncClient

On `MSG` / `POLL_CREATED` received:
```js
this._idb?.saveMsg(convId, seq, doc)
```

On `EDITED` / `DELETED` / `EXPIRED`:
```js
this._idb?.saveMsg(convId, existingSeq, updatedDoc)  // overwrite
```

On WS `open` (cursor generation for HELLO):
```js
// If IDB enabled: load cursors from IDB (real lastSeq, not 0)
const cursors = this._idb
  ? await this._idb.getCursors()
  : [...this._cursors.entries()].map(([convId, lastSeq]) => ({ convId, lastSeq }))
```

On first load:
```js
// Hydrate in-memory store from IDB before connecting
const msgs = await this._idb.getMsgs(convId, 0, 500)
for (const m of msgs) this._insertMsg(convId, m)
```

This directly fixes the "new device missing initial data" problem from the memory context — when IDB is cleared, `lastSeq=0` is sent in HELLO, server replays everything.

---

## 7. Phase 4 — React adapter: 18 hooks + Provider

All hooks use `useSyncExternalStore` for concurrent-mode safety — each hook subscribes only to the events that can change its specific slice of data, so unrelated state changes cause zero re-renders in that component.

### 7.0 `NdeChatProvider` + `useNdeClient`

```
src/hooks/
  NdeChatProvider.jsx   ← React context holding the SyncClient instance
  useNdeClient.js       ← useContext(NdeChatContext)
```

```jsx
// Usage: wrap your app once
const client = new SyncClient({ url, deviceId, getToken, idb: true })
<NdeChatProvider client={client}>
  <App />
</NdeChatProvider>

// Any component deep in the tree:
const client = useNdeClient()
```

---

### 7.1 Connection hooks

#### `useNdeStatus()`
Returns `'connecting' | 'open' | 'closed'`.  
Re-renders only when WS connection status changes.
```js
const status = useNdeStatus()
// → show "connecting…" spinner, or "offline" banner
```

#### `useNdeQueueSize()`
Returns number of unsent messages sitting in OutQueue.  
Re-renders on every enqueue/drain. Useful for an "N messages pending" badge.
```js
const pending = useNdeQueueSize()
// → if (pending > 0) show "3 messages waiting to send"
```

---

### 7.2 Conversation list hooks

#### `useNdeConversations()`
Returns sorted array of all conversations the client knows about.  
Re-renders when a conversation is added, subject changes, or `lastSeq` advances.
```js
const convs = useNdeConversations()
// → render the sidebar list
```

#### `useNdeConversation(convId)`
Returns the full metadata doc for one conversation: `{ subject, members, admins, pins, timer, lastSeq }`.  
Re-renders only when THIS conversation's metadata changes — not when other convs or messages change.
```js
const conv = useNdeConversation('conv-123')
// → render chat header: subject, member count, disappearing timer
```

#### `useNdeUnread(convId)`
Returns `number` — how many messages are newer than the local read cursor.  
Re-renders when new messages arrive or the user marks read.
```js
const unread = useNdeUnread('conv-123')
// → red badge on sidebar item
```

---

### 7.3 Message hooks

#### `useNdeMessages(convId, opts?)`
Returns sorted array of messages for a conversation.  
Re-renders when any message in this conv changes (insert, edit, delete, react, expire).  
`opts.limit` for pagination (last N messages).
```js
const messages = useNdeMessages('conv-123')
const messages = useNdeMessages('conv-123', { limit: 50 })
// → render the message list
```

#### `useNdeMessage(convId, ulid)`
Returns a **single** message object.  
Re-renders ONLY when the specific message with this ulid changes — not when other messages in the same conv change.  
This is the key granular hook: `MessageBubble` uses it so editing one message doesn't re-render 500 others.
```js
// Inside MessageBubble:
const msg = useNdeMessage('conv-123', 'msg-ulid-ABC')
// → shows live reactions, edited flag, deleted tombstone
```

#### `useNdePoll(convId, pollUlid)`
Returns `{ question, options, multi, tally, voters, myVote }` + `vote(optionIdxs)` action.  
Re-renders only when this specific poll's tally changes.
```js
const { question, options, tally, vote, myVote } = useNdePoll('conv-123', 'poll-ulid-XYZ')
// → render PollCard with live vote bars
```

---

### 7.4 Presence & typing hooks

#### `useNdePresence(userId)`
Returns `'online' | 'offline'` for a single user.  
Re-renders only when this user's presence changes.
```js
const presence = useNdePresence('user-42')
// → green/grey dot next to avatar
```

#### `useNdePresenceBulk(userIds)`
Returns `Map<userId, 'online'|'offline'>` for a list of user IDs.  
Re-renders when any of the given users' presence changes.
```js
const presenceMap = useNdePresenceBulk(['user-1', 'user-2', 'user-3'])
// → render all member presence dots in group info panel
```

#### `useNdeTyping(convId)`
Returns `string[]` — user IDs currently typing in this conversation.  
Re-renders when someone starts or stops typing. Expired entries are auto-cleaned.
```js
const typers = useNdeTyping('conv-123')
// → ['user-2', 'user-7']
```

#### `useNdeTypingText(convId)`
Returns a ready-to-display string like `"Alice is typing…"` or `"Alice, Bob and 2 others are typing…"`.  
Re-renders only when the typing set changes.
```js
const text = useNdeTypingText('conv-123')
// → <TypingIndicator text={text} />
```

---

### 7.5 Receipt hooks

#### `useNdeReceipts(convId, seq)`
Returns `{ delivered: number, read: number, total: number }` — group receipt aggregation for a message seq.  
Re-renders only when receipts for THIS seq update.
```js
const { delivered, read, total } = useNdeReceipts('conv-123', 42)
// → show "✓✓ 5/8 read" under a message
```

#### `useNdeMessageStatus(convId, ulid)`
Returns `'pending' | 'sent' | 'delivered' | 'read' | 'failed'` for own outbound messages.  
Re-renders only when this message's status changes (ACK → delivered → read).
```js
const status = useNdeMessageStatus('conv-123', 'my-msg-ulid')
// → single tick, double tick, blue ticks, clock icon, red X
```

---

### 7.6 Pin hook

#### `useNdePins(convId)`
Returns `MsgDoc[]` — full message objects that are currently pinned, in pin order.  
Re-renders only when pins change in this conv.
```js
const pinned = useNdePins('conv-123')
// → render pinned message banner with latest pinned content
```

---

### 7.7 Action hooks (return stable callbacks — safe in useEffect deps)

#### `useNdeSendMessage(convId)`
Returns send actions for a conversation. All functions are referentially stable (don't change on re-render).
```js
const { send, sendReply, forward, createPoll, sendMedia } = useNdeSendMessage('conv-123')

send('hello world')
sendReply('hello', replyToUlid)
forward(srcUlid, 'conv-456')
createPoll('Best pizza?', ['Margherita', 'Pepperoni'], false)
```

#### `useNdeMessageActions(convId, ulid)`
Returns mutation actions for a specific message.
```js
const { edit, delete: del, react, pin, viewOnce } = useNdeMessageActions('conv-123', 'msg-ulid')

edit('corrected text')
del()
react('👍', 1)    // op: 1=add, 0=remove
pin(1)            // 1=pin, 0=unpin
viewOnce()
```

#### `useNdeGroupActions(convId)`
Returns group management actions. Only meaningful if caller is an admin.
```js
const { addMember, removeMember, promote, demote, leave, setSubject, setDescription, setTimer } =
  useNdeGroupActions('conv-123')

addMember('user-99')
promote('user-5')
setSubject('New group name')
setTimer(86400)   // 24h disappearing
```

---

### 7.8 Hook → file map

```
src/hooks/
  NdeChatProvider.jsx     ← context + provider component
  useNdeClient.js         ← access SyncClient from context

  useNdeStatus.js         ← WS status
  useNdeQueueSize.js      ← pending outbound count

  useNdeConversations.js  ← all convs (sidebar)
  useNdeConversation.js   ← single conv metadata
  useNdeUnread.js         ← unread count per conv

  useNdeMessages.js       ← message list (with limit)
  useNdeMessage.js        ← single message (granular re-render)
  useNdePoll.js           ← poll state + vote()

  useNdePresence.js       ← single user presence
  useNdePresenceBulk.js   ← multi-user presence map
  useNdeTyping.js         ← typing user IDs
  useNdeTypingText.js     ← formatted typing string

  useNdeReceipts.js       ← group receipt agg for a seq
  useNdeMessageStatus.js  ← own message delivery status

  useNdePins.js           ← pinned messages

  useNdeSendMessage.js    ← send/reply/forward/poll actions
  useNdeMessageActions.js ← edit/delete/react/pin/viewOnce
  useNdeGroupActions.js   ← member/admin/subject/timer actions

  index.js                ← re-exports all hooks
```

**18 hooks + 1 provider + 1 context hook = 20 total exports.**

---

### 7.9 Performance contract

Every hook is designed around one rule: **re-render scope = data scope**.

| Hook | Re-renders when |
|---|---|
| `useNdeStatus` | WS status changes |
| `useNdeConversations` | Any conv added or metadata changes |
| `useNdeConversation(id)` | Only THIS conv's metadata changes |
| `useNdeMessages(id)` | Any message in THIS conv changes |
| `useNdeMessage(id, ulid)` | Only THIS specific message changes |
| `useNdePoll(id, ulid)` | Only THIS poll's tally changes |
| `useNdePresence(uid)` | Only THIS user's presence changes |
| `useNdeTyping(id)` | Typing set in THIS conv changes |
| `useNdeReceipts(id, seq)` | Receipt count for THIS seq changes |
| `useNdeMessageStatus(id, ulid)` | THIS message's ACK/delivery status changes |
| `useNdePins(id)` | Pins in THIS conv change |
| Action hooks | **Never** — stable refs, no subscriptions |

This means a 500-message conversation with one message being edited causes **exactly 1 re-render** (the `MessageBubble` holding `useNdeMessage` for that ulid) — not 500.

---

### 7.10 Update `src/store/index.js`

After Phase 4, the Zustand store becomes **UI shell only** — no frame dispatch logic:
```js
// One global SyncClient instance
export const syncClient = new SyncClient({ url, deviceId, getToken, idb: true })

// Zustand only for UI state that has no SDK equivalent
export const useStore = create((set) => ({
  activeConvId: null,
  setActiveConv: (id) => set({ activeConvId: id }),
  toasts: [],
  addToast: (msg, kind) => { /* ... */ },
}))
```

---

## 8. Phase 5 — Feature test checklist (in the frontend UI)

Build a small test panel in the frontend (`src/components/TestPanel.jsx`) that exercises every feature against the live engine.

### All features to test

| # | Feature | Send action | Receive frame | Verify in UI |
|---|---|---|---|---|
| 1 | Basic send/receive | `send()` | `MSG` | Message appears |
| 2 | Edit | `edit()` | `EDITED` | Content updates |
| 3 | Delete | `delete()` | `DELETED` | Tombstone shown |
| 4 | React | `react()` | `REACTED` | Emoji count updates |
| 5 | Reply | `send(…, { replyTo })` | `MSG` w/ meta | Quote shown |
| 6 | Forward | `forward()` | `MSG` w/ fwd | Forward badge |
| 7 | Typing indicator | `typing()` | `TYPING_EVT` | "is typing…" |
| 8 | Presence | `setOnline/Offline()` | — | Dot shows green/grey |
| 9 | Delivered/Read receipt | auto + `sendRead()` | `RECEIPT` | Single/double tick |
| 10 | Group receipt agg | — | `RECEIPT_AGG` | "✓✓ 3/5" |
| 11 | Pinned messages | `pin()` | `PINNED` | Banner appears |
| 12 | Poll create | `createPoll()` | `POLL_CREATED` | Poll card |
| 13 | Vote | `vote()` | `POLL_TALLY` | Bar updates |
| 14 | View-once | `viewOnce()` | `VIEWED` | Reveals once |
| 15 | Disappearing (sweep) | `setTimer()` | `EXPIRED` | Message disappears |
| 16 | Conv timer | `setTimer()` | `TIMER_SET` | Header shows timer |
| 17 | Subject/Description | `setSubject()` | `SUBJECT_SET` | Header updates |
| 18 | Group ops (add/remove/promote) | `groupOp()` | `GROUP_EVT` | Member list updates |
| 19 | Gap fill (SYNC_GAP) | disconnect + flood + reconnect | `SYNC_GAP` | Auto SYNC_REQ |
| 20 | Offline queue | disconnect + send + reconnect | `ACK` | Message delivered |
| 21 | ACK timeout | block ACK server-side | — | Message marked `failed` |
| 22 | IDB restore | reload page | `MSG` (replay from IDB) | Messages shown instantly |
| 23 | New device | clear IDB + reconnect | `MSG` (full replay from server) | All messages arrive |
| 24 | Token refresh | expire token | reconnect attempt | Re-issues token, reconnects |

---

## 9. Implementation order

```
Phase 1 — SDK core
  sdk/EventEmitter.js             (~30 lines)
  sdk/SyncClient.js               (~300 lines — extract dispatch from store/index.js)
  sdk/index.js                    (re-exports)
  ws/WsClient.js                  (1 change: token → getToken async callback)

Phase 2 — Outbound queue
  sdk/OutQueue.js                 (~60 lines)
  → wire into SyncClient._send() and onopen

Phase 3 — IndexedDB
  sdk/IdbStore.js                 (~120 lines)
  → wire into SyncClient init/MSG/cursor save

Phase 4 — React hooks (build in this order — each one is small ~30-50 lines)
  hooks/NdeChatProvider.jsx       (context setup)
  hooks/useNdeClient.js           (useContext)

  hooks/useNdeStatus.js           (connection status)
  hooks/useNdeQueueSize.js        (pending count)

  hooks/useNdeConversations.js    (sidebar list)
  hooks/useNdeConversation.js     (single conv)
  hooks/useNdeUnread.js           (unread badge)

  hooks/useNdeMessages.js         (message list)
  hooks/useNdeMessage.js          (single message — key for perf)
  hooks/useNdePoll.js             (poll card)

  hooks/useNdePresence.js         (presence dot)
  hooks/useNdePresenceBulk.js     (group info panel)
  hooks/useNdeTyping.js           (typing user IDs)
  hooks/useNdeTypingText.js       (formatted string)

  hooks/useNdeReceipts.js         (double-tick counters)
  hooks/useNdeMessageStatus.js    (own message tick state)
  hooks/useNdePins.js             (pinned banner)

  hooks/useNdeSendMessage.js      (Composer actions)
  hooks/useNdeMessageActions.js   (MessageBubble context menu)
  hooks/useNdeGroupActions.js     (ConvInfoPanel)

  hooks/index.js                  (barrel export)
  store/index.js                  (slim to UI shell)
  App.jsx                         (wrap with NdeChatProvider)

Phase 5 — Test UI
  components/TestPanel.jsx        (24-feature checklist UI)
```

---

## 10. Files summary

### SDK core (Phase 1–3)

| File | New/Updated | Phase |
|---|---|---|
| `src/sdk/EventEmitter.js` | NEW | 1 |
| `src/sdk/SyncClient.js` | NEW | 1 |
| `src/sdk/index.js` | NEW | 1 |
| `src/sdk/OutQueue.js` | NEW | 2 |
| `src/sdk/IdbStore.js` | NEW | 3 |
| `src/ws/WsClient.js` | UPDATE (getToken callback) | 1 |
| `src/ws/frames.js` | UNCHANGED | — |
| `src/ws/ulid.js` | UNCHANGED | — |

### React hooks (Phase 4) — 20 files

| File | Purpose |
|---|---|
| `src/hooks/NdeChatProvider.jsx` | Context + provider component |
| `src/hooks/useNdeClient.js` | Access SyncClient from context |
| `src/hooks/useNdeStatus.js` | WS `'connecting'|'open'|'closed'` |
| `src/hooks/useNdeQueueSize.js` | Unsent message count |
| `src/hooks/useNdeConversations.js` | All convs array (sidebar) |
| `src/hooks/useNdeConversation.js` | Single conv metadata |
| `src/hooks/useNdeUnread.js` | Unread count per conv |
| `src/hooks/useNdeMessages.js` | Message list (+ limit) |
| `src/hooks/useNdeMessage.js` | Single message — granular re-render |
| `src/hooks/useNdePoll.js` | Poll state + vote() |
| `src/hooks/useNdePresence.js` | Single user presence |
| `src/hooks/useNdePresenceBulk.js` | Multi-user presence map |
| `src/hooks/useNdeTyping.js` | Typing user IDs array |
| `src/hooks/useNdeTypingText.js` | "Alice is typing…" string |
| `src/hooks/useNdeReceipts.js` | Group receipt agg for a seq |
| `src/hooks/useNdeMessageStatus.js` | Own message delivery status |
| `src/hooks/useNdePins.js` | Pinned messages in a conv |
| `src/hooks/useNdeSendMessage.js` | send / reply / forward / poll actions |
| `src/hooks/useNdeMessageActions.js` | edit / delete / react / pin / viewOnce |
| `src/hooks/useNdeGroupActions.js` | member / admin / subject / timer actions |
| `src/hooks/index.js` | Re-exports all 18 hooks + provider |

### App layer (Phase 4–5)

| File | New/Updated |
|---|---|
| `src/store/index.js` | UPDATE — UI shell only (activeConvId, toasts) |
| `src/App.jsx` | UPDATE — wrap with `NdeChatProvider` |
| `src/components/TestPanel.jsx` | NEW — 24-feature test UI |

**Total: ~1100 lines across 27 new/updated files.**

---

## 11. One change to `WsClient.js` needed in Phase 1

Replace the hardcoded `token` with a `getToken` async callback so JWT can be refreshed on each reconnect attempt:

```js
// Before:
constructor({ url, deviceId, token, ... })
// ws.onopen: ws.send(mkHello(deviceId, token, cursors))

// After:
constructor({ url, deviceId, getToken, ... })
// ws.onopen: const token = await getToken(); ws.send(mkHello(deviceId, token, cursors))
```

This is the only change to the existing `src/ws/` files.
