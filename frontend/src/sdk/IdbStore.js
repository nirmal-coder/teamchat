/**
 * IndexedDB persistence layer — schema v2.
 *
 * Features:
 *   - AES-GCM-256 at-rest encryption via CryptoStore (set via setCrypto())
 *   - 30-day message retention + per-conv cap of 1 000 messages (WhatsApp style)
 *     (always keeps last 50 regardless of age so the conv never appears empty)
 *   - Conversation preferences store (mute / archive / favourite / draft)
 *   - Paginated reads: getMessagesBefore(convId, beforeSeq, limit)
 *   - Local full-text search: searchMessages(query, limit)
 *
 * Schema v2:
 *   messages       keyPath=[convId, seq]   index: by_conv_ulid=[convId,ulid]
 *   cursors        keyPath=convId
 *   conversations  keyPath=convId
 *   prefs          keyPath=convId          ← new in v2
 *
 * v1 → v2 migration: messages + conversations stores are cleared because the
 * encrypted record shape changed. Cursors are preserved so delta-sync requests
 * the right data from the server without re-fetching everything.
 */

const DB_VERSION       = 5
const RETENTION_DAYS   = 30
const MAX_MSGS_PER_CONV = 1_000
const MIN_MSGS_KEEP    = 50   // always keep this many recent msgs per conv

export class IdbStore {
  constructor(dbName = 'nde-sync') {
    this._dbName  = dbName
    this._db      = null
    this._crypto  = null   // CryptoStore, injected via setCrypto()
  }

  setCrypto(crypto) { this._crypto = crypto }

  // ── Open / upgrade ────────────────────────────────────────────────────────

  async open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this._dbName, DB_VERSION)

      req.onupgradeneeded = (e) => {
        const db = e.target.result
        const oldVersion = e.oldVersion

        // v1 → v2: clear data-format-dependent stores, add prefs
        if (oldVersion === 1) {
          if (db.objectStoreNames.contains('messages'))     db.deleteObjectStore('messages')
          if (db.objectStoreNames.contains('conversations')) db.deleteObjectStore('conversations')
        }
        // v2 → v3: clear messages that had payload stored as "[object Object]" (CBOR Binary bug fix)
        if (oldVersion === 2) {
          if (db.objectStoreNames.contains('messages')) db.deleteObjectStore('messages')
        }
        // v3 → v4: clear orphaned negative-seq pending messages
        if (oldVersion === 3) {
          if (db.objectStoreNames.contains('messages')) db.deleteObjectStore('messages')
        }
        // v4 → v5: v4 cleared messages but not cursors, leaving stale cursors that tell the
        // server "client already has seq N" even though IDB is empty. Clear cursors so the
        // server resends all messages on next HELLO.
        if (oldVersion === 4) {
          if (db.objectStoreNames.contains('cursors')) db.deleteObjectStore('cursors')
        }

        if (!db.objectStoreNames.contains('messages')) {
          const ms = db.createObjectStore('messages', { keyPath: ['convId', 'seq'] })
          ms.createIndex('by_conv_ulid', ['convId', 'ulid'], { unique: false })
        }
        if (!db.objectStoreNames.contains('cursors')) {
          db.createObjectStore('cursors', { keyPath: 'convId' })
        }
        if (!db.objectStoreNames.contains('conversations')) {
          db.createObjectStore('conversations', { keyPath: 'convId' })
        }
        if (!db.objectStoreNames.contains('prefs')) {
          db.createObjectStore('prefs', { keyPath: 'convId' })
        }
      }

      req.onsuccess = () => {
        this._db = req.result
        // Retention runs in background; never blocks startup
        this._runRetentionCleanup().catch(() => {})
        resolve()
      }
      req.onerror = () => reject(req.error)
    })
  }

  _tx(stores, mode = 'readonly') {
    return this._db.transaction(stores, mode)
  }

  // ── Encryption helpers ────────────────────────────────────────────────────

  /**
   * Prepare a message for IDB storage.
   * Keeps indexable/query fields plaintext; encrypts the rest.
   * If no crypto, stores everything plaintext (backward compat).
   */
  async _encryptMsg(convId, msg) {
    // Fields that must stay plaintext: IDB key + index fields + retention ts
    const { convId: _c, seq, ulid, ts, ...rest } = msg
    if (!this._crypto?.ready) {
      return { convId, seq: seq ?? 0, ulid: ulid ?? '', ts: ts ?? 0, ...rest }
    }
    const enc = await this._crypto.encrypt(rest)
    if (!enc) {
      return { convId, seq: seq ?? 0, ulid: ulid ?? '', ts: ts ?? 0, ...rest }
    }
    return { convId, seq: seq ?? 0, ulid: ulid ?? '', ts: ts ?? 0, enc }
  }

  async _decryptMsg(record) {
    if (!record) return null
    if (!record.enc) return record             // plaintext (no crypto, or pre-v2 migration)
    if (!this._crypto?.ready) return null      // encrypted but key unavailable
    const rest = await this._crypto.decrypt(record.enc)
    if (!rest) return null                     // corrupted or wrong key
    return { convId: record.convId, seq: record.seq, ulid: record.ulid, ts: record.ts, ...rest }
  }

  async _encryptConv(conv) {
    const { convId, ...rest } = conv
    if (!this._crypto?.ready) return conv
    const enc = await this._crypto.encrypt(rest)
    if (!enc) return conv
    return { convId, enc }
  }

  async _decryptConv(record) {
    if (!record) return null
    if (!record.enc) return record
    if (!this._crypto?.ready) return null
    const rest = await this._crypto.decrypt(record.enc)
    if (!rest) return null
    return { convId: record.convId, ...rest }
  }

  // ── Messages ─────────────────────────────────────────────────────────────

  async putMessage(convId, msg) {
    if (!this._db) return
    const stored = await this._encryptMsg(convId, msg)
    return new Promise((resolve, reject) => {
      const tx = this._tx('messages', 'readwrite')
      tx.objectStore('messages').put(stored)
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
  }

  /** Load all messages for a conv from a given seq (inclusive). */
  async getMessages(convId, fromSeq = 0) {
    if (!this._db) return []
    const records = await new Promise((resolve, reject) => {
      const tx = this._tx('messages')
      const range = IDBKeyRange.bound([convId, fromSeq], [convId, Infinity])
      const req = tx.objectStore('messages').getAll(range)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const results = await Promise.all(records.map(r => this._decryptMsg(r)))
    return results.filter(Boolean)
  }

  /**
   * Paginated load — fetch `limit` messages BEFORE `beforeSeq` (newest-first
   * cursor walk, returned in ascending order).
   */
  async getMessagesBefore(convId, beforeSeq, limit = 50) {
    if (!this._db) return []
    const records = await new Promise((resolve, reject) => {
      const tx = this._tx('messages')
      const range = IDBKeyRange.bound([convId, 1], [convId, beforeSeq - 1])
      const req = tx.objectStore('messages').openCursor(range, 'prev')
      const buf = []
      req.onsuccess = (e) => {
        const cursor = e.target.result
        if (!cursor || buf.length >= limit) { resolve(buf.reverse()); return }
        buf.push(cursor.value)
        cursor.continue()
      }
      req.onerror = () => reject(req.error)
    })
    const results = await Promise.all(records.map(r => this._decryptMsg(r)))
    return results.filter(Boolean)
  }

  /**
   * Local full-text search across all stored messages.
   * O(n) over all records — suitable for tens of thousands of messages.
   * Returns up to `limit` results sorted by most-recent first.
   */
  async searchMessages(query, limit = 30) {
    if (!this._db || !query) return []
    const allRecords = await new Promise((resolve, reject) => {
      const tx = this._tx('messages')
      const req = tx.objectStore('messages').getAll()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    // Decrypt in parallel, then filter
    const decrypted = await Promise.all(allRecords.map(r => this._decryptMsg(r)))
    const q = query.toLowerCase()
    return decrypted
      .filter(m => m && !m.deleted && !m.expired && m.payload?.toLowerCase().includes(q))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit)
  }

  // ── Conversations ─────────────────────────────────────────────────────────

  async putConversation(conv) {
    if (!this._db) return
    const stored = await this._encryptConv(conv)
    return new Promise((resolve, reject) => {
      const tx = this._tx('conversations', 'readwrite')
      tx.objectStore('conversations').put(stored)
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
  }

  async getConversations() {
    if (!this._db) return []
    const records = await new Promise((resolve, reject) => {
      const tx = this._tx('conversations')
      const req = tx.objectStore('conversations').getAll()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const results = await Promise.all(records.map(r => this._decryptConv(r)))
    return results.filter(Boolean)
  }

  // ── Cursors ───────────────────────────────────────────────────────────────

  async setCursor(convId, lastSeq) {
    if (!this._db) return
    return new Promise((resolve, reject) => {
      const tx = this._tx('cursors', 'readwrite')
      tx.objectStore('cursors').put({ convId, lastSeq })
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
  }

  async getCursors() {
    if (!this._db) return []
    return new Promise((resolve, reject) => {
      const tx = this._tx('cursors')
      const req = tx.objectStore('cursors').getAll()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }

  // ── Prefs ────────────────────────────────────────────────────────────────

  async putConvPref(convId, prefs) {
    if (!this._db) return
    return new Promise((resolve, reject) => {
      const tx = this._tx('prefs', 'readwrite')
      tx.objectStore('prefs').put({ ...prefs, convId })
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
  }

  async getConvPref(convId) {
    if (!this._db) return null
    return new Promise((resolve, reject) => {
      const tx = this._tx('prefs')
      const req = tx.objectStore('prefs').get(convId)
      req.onsuccess = () => resolve(req.result ?? null)
      req.onerror = () => reject(req.error)
    })
  }

  async getAllPrefs() {
    if (!this._db) return []
    return new Promise((resolve, reject) => {
      const tx = this._tx('prefs')
      const req = tx.objectStore('prefs').getAll()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }

  // ── Retention (30-day TTL + per-conv cap) ────────────────────────────────

  async _runRetentionCleanup() {
    const cutoffTs = Date.now() - RETENTION_DAYS * 86_400_000
    const convIds = await new Promise((resolve, reject) => {
      const tx = this._tx('conversations')
      const req = tx.objectStore('conversations').getAllKeys()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    // Process each conv separately to keep transactions short
    for (const convId of convIds) {
      await this._pruneConv(convId, cutoffTs).catch(() => {})
    }
  }

  async _pruneConv(convId, cutoffTs) {
    // Get all stored records for this conv (key fields only — no decryption needed for pruning)
    const keys = await new Promise((resolve, reject) => {
      const tx = this._tx('messages')
      const range = IDBKeyRange.bound([convId, 0], [convId, Infinity])
      const req = tx.objectStore('messages').getAllKeys(range)
      req.onsuccess = () => resolve(req.result)   // [[convId, seq], ...]
      req.onerror = () => reject(req.error)
    })

    if (keys.length <= MIN_MSGS_KEEP) return  // Too few to prune

    // Fetch full records only when there's actually something to remove
    const recs = await new Promise((resolve, reject) => {
      const tx = this._tx('messages')
      const range = IDBKeyRange.bound([convId, 0], [convId, Infinity])
      const req = tx.objectStore('messages').getAll(range)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })

    // Sort ascending by seq; last MIN_MSGS_KEEP are always kept
    const sorted = recs.sort((a, b) => a.seq - b.seq)
    const keepFromEnd = sorted.slice(-MIN_MSGS_KEEP).map(r => r.seq)
    const keepSet = new Set(keepFromEnd)

    const toDelete = sorted.filter((r, i) => {
      if (keepSet.has(r.seq)) return false         // always keep last MIN_MSGS_KEEP
      const overCap = i < sorted.length - MAX_MSGS_PER_CONV  // beyond per-conv cap
      const tooOld  = r.ts < cutoffTs              // older than retention window
      return overCap || tooOld
    })

    if (!toDelete.length) return

    await new Promise((resolve, reject) => {
      const tx = this._tx('messages', 'readwrite')
      const store = tx.objectStore('messages')
      for (const r of toDelete) store.delete([r.convId, r.seq])
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
  }
}
