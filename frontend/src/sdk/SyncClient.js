import { EventEmitter } from './EventEmitter.js'
import { OutQueue } from './OutQueue.js'
import { IdbStore } from './IdbStore.js'
import { CryptoStore } from './CryptoStore.js'
import { WsClient } from '../ws/WsClient.js'
import { T, E, CT, E_MSG, mkSend, mkDelivered, mkRead, mkEdit, mkDelete, mkReact,
  mkTyping, mkGroupOp, mkPin, mkPoll, mkVote, mkViewOnce,
  mkConvTimer, mkSubject, mkPresence, mkSyncReq, mkHello, mkForward } from '../ws/frames.js'
import { ulid } from '../ws/ulid.js'

const textEnc = new TextEncoder()
const textDec = new TextDecoder()

const MAX_PAYLOAD_BYTES = 64_000   // guard before sending

function payloadToText(p) {
  if (!p) return ''
  if (typeof p === 'string') return p
  if (p instanceof Uint8Array || p instanceof ArrayBuffer) return textDec.decode(p)
  return String(p)
}

const _EMPTY_ARRAY = Object.freeze([])
const _EMPTY_MAP   = Object.freeze(new Map())

/**
 * SyncClient — framework-agnostic, event-driven sync engine client.
 *
 * Events emitted (subscribe via .on(event, notify)):
 *   'status'                    — WS status: 'connecting'|'open'|'closed'|'auth_failed'
 *   'queue:size'                — OutQueue size changed
 *   'conv:list'                 — conversation list changed
 *   'conv:{convId}'             — specific conv metadata changed
 *   'msg:list:{convId}'         — any message in conv changed
 *   'msg:{convId}:{ulid}'       — specific message changed
 *   'poll:{convId}:{ulid}'      — poll tally updated
 *   'presence:{userId}'         — specific user presence changed
 *   'presence:bulk'             — any presence changed
 *   'typing:{convId}'           — typing state changed
 *   'receipts:{convId}:{seq}'   — receipt aggregate updated
 *   'msgstatus:{convId}:{ulid}' — own message delivery status updated
 *   'pins:{convId}'             — pins changed
 *   'prefs:{convId}'            — conv preferences (mute/archive/etc.) changed
 *   'toast'                     — (msg, kind) UI notification
 */
export class SyncClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string}   opts.userId
   * @param {string}   opts.deviceId
   * @param {Function} [opts.getToken]   async () => tokenString (preferred)
   * @param {string}   [opts.token]      static token (fallback)
   * @param {string}   opts.wsUrl
   * @param {string}   [opts.httpUrl]    base URL for HTTP actions (media upload etc.)
   * @param {boolean}  [opts.useIdb]     default true
   * @param {string}   [opts.idbName]    default 'nde-sync' — scope per workspace/user
   * @param {number}   [opts.outMaxSize] OutQueue max buffered messages (default 200)
   * @param {number}   [opts.outTtlMs]   OutQueue TTL (default 24h)
   */
  constructor({
    userId, deviceId, getToken, token, wsUrl, httpUrl,
    useIdb = true, idbName = 'nde-sync',
    outMaxSize, outTtlMs,
  }) {
    super()
    this.userId    = userId
    this.deviceId  = deviceId
    this._getToken = typeof getToken === 'function' ? getToken : () => Promise.resolve(token ?? '')
    this._wsUrl    = wsUrl
    this._httpUrl  = httpUrl ?? null

    // WS connection state
    this._wsStatus  = 'closed'
    this._sessionId = null

    // Conversations: Map<convId, ConvDoc>
    this.conversations = new Map()
    this._convArray    = []   // sorted by lastSeq desc; updated in-place

    // Messages: Map<convId, Map<seq, MsgDoc>>
    this._msgs     = new Map()
    // ULID → seq reverse index: Map<convId, Map<ulid, seq>>
    this._ulidIdx  = new Map()
    // Pre-sorted arrays: Map<convId, MsgDoc[]>
    this._msgArrays = new Map()

    // Presence: Map<userId, 'online'|'offline'> — replaced on each update
    this.presence = new Map()
    // Typing: Map<convId, Map<userId, expiresAt>> — replaced on each update
    this.typing = new Map()
    // Conv preferences: Map<convId, PrefDoc>
    this._prefs = new Map()

    this._outQueue = new OutQueue({ maxSize: outMaxSize, ttlMs: outTtlMs })
    this._idb      = useIdb ? new IdbStore(idbName) : null

    // Typing debounce + cleanup timers
    this._typingTimer   = null
    this._typingCleanup = new Map()  // convId:userId → timeoutId

    // Debounced DELIVERED per conv
    this._deliveredTimers = {}
    this._deliveredSeqs   = {}

    // SYNC_GAP dedup: prevent re-requesting the same gap repeatedly
    this._pendingGapReqs = new Set()

    this._wsc = new WsClient({
      url:         wsUrl,
      deviceId,
      getToken:    this._getToken,
      getCursors:  () => this._getCursors(),
      onFrame:     (type, fields) => this._dispatch(type, fields),
      onStatus:    (status) => this._onStatus(status),
    })

    this._destroyed = false   // set true in destroy(); used by NdeChatProvider

    // Convs the user created locally — GROUP_OP resent after every WELCOME
    // so membership is re-established when the server restarts.
    this._createdConvs = new Set()

    // True after the first WELCOME on the current WS connection.
    // Used by joinConv to decide whether to send GROUP_OPs directly
    // (already authenticated) or wait for the next WELCOME.
    this._welcomed = false
  }

  get destroyed() { return this._destroyed }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start() {
    if (this._idb) {
      try {
        const crypto = new CryptoStore(this.userId, this.deviceId)
        await crypto.init()
        this._idb.setCrypto(crypto)
        await this._idb.open()
        await this._loadFromIdb()
      } catch (e) {
        console.warn('[SyncClient] IDB open failed, continuing without persistence', e)
      }
    }
    this._wsc.connect()
  }

  destroy() {
    this._destroyed = true
    this._wsc.destroy()
    this._outQueue.clear()
    clearTimeout(this._typingTimer)
    this._typingCleanup.forEach(t => clearTimeout(t))
    this._typingCleanup.clear()
    Object.values(this._deliveredTimers).forEach(clearTimeout)
    this.removeAllListeners()
  }

  // ── Stable-ref getters (React snapshot functions) ─────────────────────────

  getStatus()          { return this._wsStatus }
  getQueueSize()       { return this._outQueue.size }
  getConversations()   { return this._convArray }
  getConversation(id)  { return this.conversations.get(id) ?? null }
  getMessages(convId)  { return this._msgArrays.get(convId) ?? _EMPTY_ARRAY }
  getMessage(convId, ulid_) {
    const seq = this._ulidIdx.get(convId)?.get(ulid_)
    if (seq === undefined) return null
    return this._msgs.get(convId)?.get(seq) ?? null
  }
  getMessageBySeq(convId, seq) { return this._msgs.get(convId)?.get(seq) ?? null }
  getPresence(userId)  { return this.presence.get(userId) ?? 'offline' }
  getTyping(convId)    { return this.typing.get(convId) ?? _EMPTY_MAP }
  getConvPrefs(convId) { return this._prefs.get(convId) ?? null }

  getUnread(convId) {
    const conv = this.conversations.get(convId)
    if (!conv) return 0
    const cursor = conv.lastReadSeq ?? 0
    return (this._msgArrays.get(convId) ?? [])
      .filter(m => m.seq > cursor && m.seq > 0 && m.senderId !== this.userId)
      .length
  }

  // ── IDB bootstrap ─────────────────────────────────────────────────────────

  async _loadFromIdb() {
    const [convs, cursors, allPrefs] = await Promise.all([
      this._idb.getConversations(),
      this._idb.getCursors(),
      this._idb.getAllPrefs(),
    ])
    const cursorMap = new Map(cursors.map(c => [c.convId, c.lastSeq]))
    for (const conv of convs) {
      this._upsertConv(conv.convId, { ...conv, lastSeq: cursorMap.get(conv.convId) ?? conv.lastSeq ?? 0 }, false)
    }
    await Promise.all(convs.map(async (conv) => {
      const msgs = await this._idb.getMessages(conv.convId, 0)
      for (const msg of msgs) this._insertMsg(conv.convId, msg, false)
    }))
    for (const pref of allPrefs) this._prefs.set(pref.convId, pref)
    // Rebuild stable arrays once (avoid per-insert overhead during bulk load)
    this._rebuildConvArray()
    if (this.conversations.size > 0) this.emit('conv:list')
  }

  // ── WS callbacks ─────────────────────────────────────────────────────────

  _onStatus(status) {
    this._wsStatus = status
    this.emit('status')
    if (status === 'open') {
      // Clear gap-req dedup on reconnect so any unresolved gaps can retry
      this._pendingGapReqs.clear()
      this._wsc.send(mkPresence(this.userId, 1))
      this._outQueue.drain((buf) => this._wsc.send(buf))
    } else if (status === 'closed' || status === 'connecting') {
      // Reset welcomed flag — the current WS session is gone.
      // The next WELCOME will re-set it and re-flush createdConvs GROUP_OPs.
      this._welcomed = false
    } else if (status === 'auth_failed') {
      this._welcomed = false
      this.emit('toast', 'Authentication failed — please log in again.', 'error')
    }
  }

  _getCursors() {
    return [...this.conversations.values()].map(c => ({ convId: c.convId, lastSeq: c.lastSeq ?? 0 }))
  }

  // ── Frame dispatch ────────────────────────────────────────────────────────

  _dispatch(type, fields) {
    switch (type) {

      case T.WELCOME: {
        const [, sessionId] = fields
        this._sessionId = sessionId
        this._welcomed = true
        // Send GROUP_OP for all locally-created convs now that the session is
        // authenticated (WELCOME guarantees HELLO has been fully processed on the
        // server, so s.userId is set). Idempotent — engine ignores if already a member.
        for (const convId of this._createdConvs) {
          this._wsc.send(mkGroupOp(ulid(), convId, 1, this.userId))
        }
        break
      }

      case T.ACK: {
        const [ulid_, convId, seq, serverTs] = fields
        this._outQueue.remove(ulid_)
        this.emit('queue:size')
        // Patch only ts + status — do NOT include seq here.
        // If we mutate msg.seq from -T (pending) to realSeq while the msg is
        // still in _msgArrays at the -T sorted position, the binary-search
        // invariant breaks. When MSG arrives via fanout, _binaryFind(arr, -T)
        // would fail to find the old entry → duplicate bubble appears.
        // The MSG frame (sender also receives it via fanout deliverLocal)
        // handles the -T → realSeq promotion cleanly inside _insertMsg.
        this._patchByUlid(convId, ulid_, { ts: serverTs, status: 'sent' })
        this._upsertConv(convId, { lastSeq: seq })
        this.emit(`conv:${convId}`)
        this.emit('conv:list')
        // Remove any pending gap reqs for this conv
        for (const key of this._pendingGapReqs) {
          if (key.startsWith(`${convId}:`)) this._pendingGapReqs.delete(key)
        }
        break
      }

      case T.MSG: {
        const [convId, seq, ulid_, senderId, contentType, payload, ts, meta] = fields
        const text = contentType === CT.POLL ? null : payloadToText(payload)
        const msg = {
          ulid: ulid_, seq, senderId, contentType,
          payload: text, rawPayload: payload, ts, meta,
          status: 'received', reactions: {},
          replyTo: meta?.replyTo ?? null, fwd: meta?.fwd ?? 0, ttl: meta?.ttl ?? 0,
          edited: false, deleted: false, expired: false,
        }
        if (contentType === CT.POLL) {
          try { msg.poll = JSON.parse(payloadToText(payload)) } catch {}
        }
        this._insertMsg(convId, msg)
        this._upsertConv(convId, { lastSeq: seq })
        this.emit(`conv:${convId}`)
        this.emit('conv:list')
        // Debounced DELIVERED (flush to OutQueue if WS closes before timer fires)
        this._deliveredSeqs[convId] = Math.max(this._deliveredSeqs[convId] || 0, seq)
        clearTimeout(this._deliveredTimers[convId])
        this._deliveredTimers[convId] = setTimeout(() => {
          if (this._wsStatus === 'open') {
            this._wsc.send(mkDelivered(convId, this._deliveredSeqs[convId]))
          }
          delete this._deliveredTimers[convId]
          delete this._deliveredSeqs[convId]
        }, 400)
        break
      }

      case T.EDITED: {
        const [convId, , targetUlid, newPayload, editTs, editorId] = fields
        this._patchByUlid(convId, targetUlid, {
          payload: payloadToText(newPayload), edited: true, editTs, editorId,
        })
        break
      }

      case T.DELETED: {
        const [convId, , targetUlid, deleterId] = fields
        this._patchByUlid(convId, targetUlid, { deleted: true, deletedBy: deleterId, payload: null })
        break
      }

      case T.REACTED: {
        const [convId, , targetUlid, userId_, emoji, op] = fields
        const msg = this.getMessage(convId, targetUlid)
        if (msg) {
          const reactions = { ...msg.reactions }
          if (op === 1) reactions[userId_] = emoji
          else delete reactions[userId_]
          this._patchByUlid(convId, targetUlid, { reactions })
        }
        break
      }

      case T.RECEIPT: {
        const [convId, seq, , kind] = fields
        const msg = this.getMessageBySeq(convId, seq)
        if (msg?.senderId === this.userId) {
          this._patchMsg(convId, seq, { status: kind === 2 ? 'read' : 'delivered' })
          this.emit(`msgstatus:${convId}:${msg.ulid}`)
        }
        break
      }

      case T.RECEIPT_AGG: {
        const [convId, seq, deliveredCount, readCount, total] = fields
        const msg = this.getMessageBySeq(convId, seq)
        if (msg) {
          this._patchMsg(convId, seq, { receiptAgg: { delivered: deliveredCount, read: readCount, total } })
          this.emit(`receipts:${convId}:${seq}`)
        }
        break
      }

      case T.TYPING_EVT: {
        const [convId, userId_, state, expiresAt] = fields
        const convTyping = new Map(this.typing.get(convId) ?? [])
        if (state === 1) {
          convTyping.set(userId_, expiresAt)
          // Auto-remove when the server-provided expiry passes
          const key = `${convId}:${userId_}`
          clearTimeout(this._typingCleanup.get(key))
          const delay = Math.max(0, expiresAt - Date.now()) + 100
          const timer = setTimeout(() => this._cleanTyping(convId, userId_, expiresAt), delay)
          this._typingCleanup.set(key, timer)
        } else {
          convTyping.delete(userId_)
          const key = `${convId}:${userId_}`
          clearTimeout(this._typingCleanup.get(key))
          this._typingCleanup.delete(key)
        }
        const newTyping = new Map(this.typing)
        newTyping.set(convId, convTyping)
        this.typing = newTyping
        this.emit(`typing:${convId}`)
        break
      }

      case T.PINNED: {
        const [convId, , targetUlid, , on] = fields
        const conv = this.conversations.get(convId)
        if (conv) {
          const pins = on
            ? [...new Set([...(conv.pins ?? []), targetUlid])]
            : (conv.pins ?? []).filter(p => p !== targetUlid)
          this._upsertConv(convId, { pins })
          this.emit(`pins:${convId}`)
        }
        this._patchByUlid(convId, targetUlid, { pinned: on === 1 })
        break
      }

      case T.POLL_CREATED: {
        const [convId, seq, ulid_, by, question, options, multi, ts] = fields
        this._insertMsg(convId, {
          ulid: ulid_, seq, senderId: by, contentType: CT.POLL,
          payload: null, ts, status: 'received', reactions: {},
          poll: { question, options, multi, tally: options.map(() => 0), voters: {} },
          edited: false, deleted: false, expired: false,
        })
        this._upsertConv(convId, { lastSeq: seq })
        this.emit(`conv:${convId}`)
        this.emit('conv:list')
        break
      }

      case T.POLL_TALLY: {
        const [convId, , pollUlid, tally, voters] = fields
        const msg = this.getMessage(convId, pollUlid)
        if (msg?.poll) {
          this._patchByUlid(convId, pollUlid, { poll: { ...msg.poll, tally, voters } })
          this.emit(`poll:${convId}:${pollUlid}`)
        }
        break
      }

      case T.VIEWED: {
        const [convId, , targetUlid, viewerId] = fields
        const msg = this.getMessage(convId, targetUlid)
        if (msg) {
          const viewedBy = [...new Set([...(msg.viewedBy ?? []), viewerId])]
          // Erase content for everyone once at least one party has viewed
          this._patchByUlid(convId, targetUlid, { viewedBy, payload: null })
        }
        break
      }

      case T.EXPIRED: {
        const [convId, seq, targetUlid] = fields
        this._patchByUlid(convId, targetUlid, { seq, expired: true, payload: null })
        break
      }

      case T.TIMER_SET: {
        const [convId, , , seconds] = fields
        this._upsertConv(convId, { timer: seconds })
        this.emit(`conv:${convId}`)
        break
      }

      case T.SUBJECT_SET: {
        const [convId, , , field, value] = fields
        // Guard against prototype-pollution via dynamic field name
        if (typeof field === 'string' && !field.startsWith('__')) {
          this._upsertConv(convId, { [field]: value })
          this.emit(`conv:${convId}`)
          this.emit('conv:list')
        }
        break
      }

      case T.GROUP_EVT: {
        const [convId, , op, , target] = fields
        // Create conv if missing — handles server-push of a new conv the client doesn't know yet
        const conv = this.conversations.get(convId) ?? { convId, lastSeq: 0, members: [], admins: [] }
        let members = [...(conv.members ?? [])]
        let admins  = [...(conv.admins  ?? [])]
        if (op === 1) members = [...new Set([...members, target].filter(Boolean))]
        if (op === 2) members = members.filter(m => m !== target)
        if (op === 3) admins  = [...new Set([...admins,  target].filter(Boolean))]
        if (op === 4) admins  = admins.filter(a => a !== target)
        if (op === 5) members = members.filter(m => m !== target)  // self-exit
        this._upsertConv(convId, { members, admins })
        this.emit(`conv:${convId}`)
        this.emit('conv:list')
        break
      }

      case T.PRESENCE: {
        const [userId_, state] = fields
        const newPresence = new Map(this.presence)
        newPresence.set(userId_, state === 1 ? 'online' : 'offline')
        this.presence = newPresence
        this.emit(`presence:${userId_}`)
        this.emit('presence:bulk')
        break
      }

      case T.SYNC_GAP: {
        const [convId, fromSeq, , useRest] = fields
        console.warn(`[SyncClient] SYNC_GAP in ${convId} from seq ${fromSeq}`)
        if (!useRest) {
          const key = `${convId}:${fromSeq}`
          if (!this._pendingGapReqs.has(key)) {
            this._pendingGapReqs.add(key)
            this._wsc.send(mkSyncReq(convId, fromSeq))
            // Allow retry after 30 s in case the server response was lost
            setTimeout(() => this._pendingGapReqs.delete(key), 30_000)
          }
        }
        break
      }

      case T.ERR: {
        const [code, detail] = fields
        // Token expired → reconnect to get a fresh one (WsClient handles retry limit)
        if (code === E.UNAUTH) {
          this._wsc.notifyAuthFailed()
          return
        }
        // Rate limited — no immediate retry needed; server will unblock automatically
        if (code === E.RATE_LIMITED) {
          this.emit('toast', 'Slow down — you\'re sending messages too fast.', 'warn')
          return
        }
        this.emit('toast', `${E_MSG[code] ?? `Error ${code}`}${detail ? ': ' + detail : ''}`, 'error')
        break
      }

      default: break
    }
  }

  // ── Internal state mutators ───────────────────────────────────────────────

  _upsertConv(convId, patch, persist = true) {
    const existing = this.conversations.get(convId) ?? {
      convId, subject: null, members: [], admins: [], pins: [], timer: 0, lastSeq: 0,
    }
    const updated = { ...existing, ...patch }
    this.conversations.set(convId, updated)

    // Always create a NEW array reference so useSyncExternalStore detects the change.
    // Mutating the existing array in-place makes Object.is() return true → no re-render.
    const idx = this._convArray.findIndex(c => c.convId === convId)
    if (idx !== -1) {
      const next = [...this._convArray]
      next[idx] = updated
      if (patch.lastSeq !== undefined || patch.lastMsg !== undefined) {
        next.sort((a, b) => (b.lastSeq ?? 0) - (a.lastSeq ?? 0))
      }
      this._convArray = next
    } else {
      this._convArray = [...this._convArray, updated]
        .sort((a, b) => (b.lastSeq ?? 0) - (a.lastSeq ?? 0))
    }

    if (persist && this._idb) this._idb.putConversation(updated).catch(() => {})
  }

  _rebuildConvArray() {
    this._convArray = [...this.conversations.values()]
      .sort((a, b) => (b.lastSeq ?? 0) - (a.lastSeq ?? 0))
  }

  /**
   * Binary search: find insertion index for `msg` in a seq-sorted array.
   * Updates in-place if seq already exists (optimistic → confirmed move).
   */
  _binaryInsert(arr, msg) {
    let lo = 0, hi = arr.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (arr[mid].seq < msg.seq) lo = mid + 1
      else hi = mid
    }
    if (arr[lo]?.seq === msg.seq) arr[lo] = msg   // update in-place (same position)
    else arr.splice(lo, 0, msg)
  }

  _binaryFind(arr, seq) {
    let lo = 0, hi = arr.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1
      if (arr[mid].seq === seq) return mid
      if (arr[mid].seq < seq) lo = mid + 1
      else hi = mid - 1
    }
    return -1
  }

  _insertMsg(convId, msg, notify = true) {
    if (!this._msgs.has(convId)) {
      this._msgs.set(convId, new Map())
      this._ulidIdx.set(convId, new Map())
      this._msgArrays.set(convId, [])
    }
    const msgMap = this._msgs.get(convId)
    const uidx   = this._ulidIdx.get(convId)
    const arr    = this._msgArrays.get(convId)

    // Optimistic → confirmed: remove old seq entry
    if (msg.ulid) {
      const oldSeq = uidx.get(msg.ulid)
      if (oldSeq !== undefined && oldSeq !== msg.seq) {
        msgMap.delete(oldSeq)
        const oldIdx = this._binaryFind(arr, oldSeq)
        if (oldIdx !== -1) arr.splice(oldIdx, 1)
      }
    }

    msgMap.set(msg.seq, msg)
    if (msg.ulid) uidx.set(msg.ulid, msg.seq)
    this._binaryInsert(arr, msg)   // O(log n) insertion, no full sort

    // Denormalize lastMsg into conv (real messages only)
    if (msg.seq > 0) {
      const conv = this.conversations.get(convId)
      if (!conv?.lastMsg || msg.seq > (conv.lastMsg.seq ?? -1)) {
        this._upsertConv(convId, {
          lastMsg: {
            ulid: msg.ulid, seq: msg.seq, senderId: msg.senderId,
            contentType: msg.contentType, payload: msg.payload,
            ts: msg.ts, deleted: false, expired: false,
          },
        })
      }
    }

    if (this._idb) this._idb.putMessage(convId, msg).catch(() => {})

    if (notify) {
      this.emit(`msg:list:${convId}`)
      if (msg.ulid) this.emit(`msg:${convId}:${msg.ulid}`)
    }
  }

  _patchMsg(convId, seq, patch) {
    const map = this._msgs.get(convId)
    if (!map) return
    const msg = map.get(seq)
    if (!msg) return
    const updated = { ...msg, ...patch }
    map.set(seq, updated)

    // Update in-place — seq unchanged so array position is unchanged
    const arr = this._msgArrays.get(convId)
    if (arr) {
      const idx = this._binaryFind(arr, seq)
      if (idx !== -1) arr[idx] = updated
    }

    // Keep lastMsg in conv in sync
    const conv = this.conversations.get(convId)
    if (conv?.lastMsg?.ulid === msg.ulid && (patch.deleted || patch.expired || patch.payload !== undefined)) {
      this._upsertConv(convId, { lastMsg: { ...conv.lastMsg, ...patch } })
    }

    if (this._idb) this._idb.putMessage(convId, updated).catch(() => {})

    this.emit(`msg:list:${convId}`)
    if (msg.ulid) this.emit(`msg:${convId}:${msg.ulid}`)
  }

  _patchByUlid(convId, ulid_, patch) {
    const seq = this._ulidIdx.get(convId)?.get(ulid_)
    if (seq === undefined) return
    this._patchMsg(convId, seq, patch)
  }

  /** Auto-remove a typing entry after its server-provided expiry. */
  _cleanTyping(convId, userId_, expiresAt) {
    const convTyping = this.typing.get(convId)
    if (!convTyping) return
    if (convTyping.get(userId_) !== expiresAt) return  // a newer event superseded this one
    const updated = new Map(convTyping)
    updated.delete(userId_)
    const newTyping = new Map(this.typing)
    newTyping.set(convId, updated)
    this.typing = newTyping
    this.emit(`typing:${convId}`)
    this._typingCleanup.delete(`${convId}:${userId_}`)
  }

  // ── Outbound actions ──────────────────────────────────────────────────────

  sendMessage(convId, text, replyTo = null, ttl = 0) {
    const encoded = textEnc.encode(text)
    if (encoded.byteLength > MAX_PAYLOAD_BYTES) {
      this.emit('toast', 'Message too large (max 64 KB).', 'error')
      return null
    }
    const id  = ulid()
    const buf = mkSend(id, convId, CT.TEXT, encoded, replyTo, ttl)
    this._insertMsg(convId, {
      ulid: id, seq: -Date.now(), senderId: this.userId, contentType: CT.TEXT,
      payload: text, ts: Date.now(), status: 'pending',
      reactions: {}, edited: false, deleted: false, expired: false,
      replyTo, fwd: 0, ttl,
    })
    if (!this.conversations.has(convId)) this._upsertConv(convId, {})
    this._outQueue.push(id, buf, Date.now())
    this.emit('queue:size')
    if (this._wsStatus === 'open') this._wsc.send(buf)
    return id
  }

  /**
   * Send a media/file attachment message.
   * `meta` should contain { fileId, fileUrl, filename, size, mimeType }.
   */
  sendAttachment(convId, meta, caption = '') {
    const id = ulid()
    const contentType = meta.mimeType?.startsWith('image/') ? CT.IMAGE
      : meta.mimeType?.startsWith('video/') ? CT.VIDEO
      : meta.mimeType?.startsWith('audio/') ? CT.AUDIO
      : CT.DOC
    const buf = mkSend(id, convId, contentType, textEnc.encode(caption), null, 0)
    this._insertMsg(convId, {
      ulid: id, seq: -Date.now(), senderId: this.userId, contentType,
      payload: caption, meta, ts: Date.now(), status: 'pending',
      reactions: {}, edited: false, deleted: false, expired: false,
    })
    if (!this.conversations.has(convId)) this._upsertConv(convId, {})
    this._outQueue.push(id, buf, Date.now())
    this.emit('queue:size')
    if (this._wsStatus === 'open') this._wsc.send(buf)
    return id
  }

  sendRead(convId, seq) {
    this._wsc.send(mkRead(convId, seq))
    this._upsertConv(convId, { lastReadSeq: seq })
    if (this._idb) this._idb.setCursor(convId, seq).catch(() => {})
  }

  editMessage(convId, targetUlid, newText) {
    this._wsc.send(mkEdit(ulid(), convId, targetUlid, textEnc.encode(newText)))
  }

  deleteMessage(convId, targetUlid) {
    this._wsc.send(mkDelete(ulid(), convId, targetUlid, 1))
  }

  /** Optimistically toggles the reaction, then confirms with server. */
  toggleReact(convId, targetUlid, emoji) {
    const msg = this.getMessage(convId, targetUlid)
    if (!msg) return
    const hasReaction = msg.reactions?.[this.userId] === emoji
    // Optimistic update — server echo will arrive and overwrite (idempotent)
    const reactions = { ...msg.reactions }
    if (hasReaction) delete reactions[this.userId]
    else reactions[this.userId] = emoji
    this._patchByUlid(convId, targetUlid, { reactions })
    this._wsc.send(mkReact(ulid(), convId, targetUlid, emoji, hasReaction ? 0 : 1))
  }

  pinMessage(convId, targetUlid, on) {
    this._wsc.send(mkPin(ulid(), convId, targetUlid, on))
  }

  sendTyping(convId) {
    this._wsc.send(mkTyping(convId, 1))
    clearTimeout(this._typingTimer)
    this._typingTimer = setTimeout(() => this._wsc.send(mkTyping(convId, 0)), 3_000)
  }

  createPoll(convId, question, options, multi) {
    this._wsc.send(mkPoll(ulid(), convId, question, options, multi))
  }

  vote(convId, pollUlid, optionIdxs) {
    this._wsc.send(mkVote(ulid(), convId, pollUlid, optionIdxs))
  }

  consumeViewOnce(convId, targetUlid) {
    // Optimistic: erase content locally before server confirms
    this._patchByUlid(convId, targetUlid, { payload: null })
    this._wsc.send(mkViewOnce(ulid(), convId, targetUlid))
  }

  forwardMessage(convId, srcUlid, destConvId) {
    const msg = this.getMessage(convId, srcUlid)
    if (!msg) return
    const fwdScore = (msg.fwd ?? 0) + 1
    this._wsc.send(mkForward(ulid(), destConvId, srcUlid, msg.contentType, textEnc.encode(msg.payload ?? ''), fwdScore))
  }

  setConvTimer(convId, seconds) {
    this._wsc.send(mkConvTimer(ulid(), convId, seconds))
  }

  setSubject(convId, field, value) {
    this._wsc.send(mkSubject(ulid(), convId, field, value))
  }

  groupOp(convId, op, target) {
    this._wsc.send(mkGroupOp(ulid(), convId, op, target))
  }

  joinConv(convId, members = [], subject = null) {
    this._upsertConv(convId, { members, lastSeq: 0, ...(subject ? { subject } : {}) })
    this._createdConvs.add(convId)
    this.emit('conv:list')
    if (this._welcomed) {
      // Already authenticated — send GROUP_OPs synchronously so they arrive
      // at the server BEFORE any SEND frame that might follow immediately.
      // DO NOT send a new HELLO here: it would trigger _onHello again on the
      // server which (a) increments fanout interest ref-count causing a leak,
      // (b) replays all messages from lastSeq:0 (since joinConv resets it),
      // flooding the client and triggering the 'closed' reconnect loop.
      console.log('[SyncClient] joinConv direct GROUP_OPs convId=%s', convId)
      this._wsc.send(mkGroupOp(ulid(), convId, 1, this.userId))  // self-join
      for (const m of members) {
        if (m !== this.userId) this._wsc.send(mkGroupOp(ulid(), convId, 1, m))
      }
    }
    // Not yet welcomed: _createdConvs will be flushed by the WELCOME handler
    // after the initial HELLO/WELCOME handshake completes.
  }

  setPresenceOnline()  { this._wsc.send(mkPresence(this.userId, 1)) }
  setPresenceOffline() {
    if (this._wsStatus === 'open') this._wsc.send(mkPresence(this.userId, 0))
  }

  // ── Conversation preferences (local only — not synced across devices) ─────

  async setConvPref(convId, patch) {
    const existing = this._prefs.get(convId) ?? { convId }
    const updated  = { ...existing, ...patch, convId }
    this._prefs.set(convId, updated)
    this.emit(`prefs:${convId}`)
    if (this._idb) await this._idb.putConvPref(convId, updated).catch(() => {})
  }

  // ── Pagination ────────────────────────────────────────────────────────────

  /**
   * Load up to `limit` messages before `beforeSeq` from IDB, then if IDB is
   * exhausted, request from server via SYNC_REQ.
   * Returns the number of messages loaded from IDB (0 means server was queried).
   */
  async loadMoreMessages(convId, beforeSeq, limit = 50) {
    if (this._idb) {
      const msgs = await this._idb.getMessagesBefore(convId, beforeSeq, limit).catch(() => [])
      if (msgs.length > 0) {
        for (const msg of msgs) this._insertMsg(convId, msg, false)
        this.emit(`msg:list:${convId}`)
        return msgs.length
      }
    }
    // IDB empty for this range — request from server
    const fromSeq = Math.max(0, (beforeSeq ?? 0) - limit)
    this._wsc.send(mkSyncReq(convId, fromSeq))
    return 0
  }

  // ── Search ────────────────────────────────────────────────────────────────

  /**
   * Full-text search across all IDB-persisted messages.
   * Falls back to searching in-memory messages if IDB is unavailable.
   */
  async searchMessages(query, limit = 30) {
    const q = query?.trim().toLowerCase()
    if (!q) return []
    if (this._idb) {
      return this._idb.searchMessages(q, limit).catch(() => this._searchInMemory(q, limit))
    }
    return this._searchInMemory(q, limit)
  }

  _searchInMemory(q, limit) {
    const results = []
    for (const [convId, arr] of this._msgArrays) {
      for (const m of arr) {
        if (!m.deleted && !m.expired && m.payload?.toLowerCase().includes(q)) {
          results.push({ ...m, convId })
        }
      }
    }
    return results.sort((a, b) => b.ts - a.ts).slice(0, limit)
  }
}
