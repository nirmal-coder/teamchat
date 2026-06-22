/**
 * AES-GCM-256 at-rest encryption for IndexedDB.
 *
 * Threat model: prevents reading IDB data after physical database export
 * to another machine, or casual DevTools inspection.
 *
 * A random 256-bit key is generated once per userId+deviceId and stored
 * in localStorage (same origin). An attacker who can read localStorage can
 * also read the key, so this does NOT protect against full browser-profile
 * access — it only stops offline IDB file extraction.
 *
 * Degrades gracefully if crypto.subtle is unavailable (older browsers /
 * insecure contexts) — IDB is then stored without encryption.
 */

const KEY_PREFIX = 'nde-idb-key-v1'
const ALGO = { name: 'AES-GCM', length: 256 }
const enc = new TextEncoder()
const dec = new TextDecoder()

export class CryptoStore {
  constructor(userId, deviceId) {
    this._storageKey = `${KEY_PREFIX}:${userId}:${deviceId}`
    this._key = null
  }

  get ready() { return this._key !== null }

  async init() {
    if (!globalThis.crypto?.subtle) return  // Not available (HTTP context or old browser)
    try {
      const stored = localStorage.getItem(this._storageKey)
      if (stored) {
        const raw = Uint8Array.from(atob(stored), c => c.charCodeAt(0))
        this._key = await crypto.subtle.importKey('raw', raw, ALGO, false, ['encrypt', 'decrypt'])
      } else {
        // Generate new extractable key, persist raw bytes, then re-import non-extractable
        const key = await crypto.subtle.generateKey(ALGO, true, ['encrypt', 'decrypt'])
        const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key))
        localStorage.setItem(this._storageKey, btoa(String.fromCharCode(...raw)))
        this._key = await crypto.subtle.importKey('raw', raw, ALGO, false, ['encrypt', 'decrypt'])
      }
    } catch (e) {
      console.warn('[CryptoStore] init failed — IDB will store plaintext', e)
    }
  }

  /**
   * Encrypt a JS object → Uint8Array layout: [12-byte IV | ciphertext].
   * Returns null if crypto is not available.
   */
  async encrypt(obj) {
    if (!this._key) return null
    try {
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const cipher = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        this._key,
        enc.encode(JSON.stringify(obj))
      )
      const out = new Uint8Array(12 + cipher.byteLength)
      out.set(iv)
      out.set(new Uint8Array(cipher), 12)
      return out
    } catch { return null }
  }

  /**
   * Decrypt a Uint8Array produced by encrypt() → original JS object.
   * Returns null on failure (wrong key, corrupted data, etc.).
   */
  async decrypt(bytes) {
    if (!this._key || !(bytes instanceof Uint8Array)) return null
    try {
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: bytes.slice(0, 12) },
        this._key,
        bytes.slice(12)
      )
      return JSON.parse(dec.decode(plain))
    } catch { return null }
  }

  /** Remove the stored key (e.g. on logout). Cached IDB data becomes unreadable. */
  purge() {
    localStorage.removeItem(this._storageKey)
    this._key = null
  }
}
