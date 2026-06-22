import { T, decodeFrame, mkHello, mkPing, mkPong } from './frames.js'

const T_NAME = Object.fromEntries(
  Object.entries(T).map(([k, v]) => [v, k])
)

const PING_INTERVAL = 20_000
const MAX_BACKOFF   = 30_000
const AUTH_FAIL_MAX = 3   // Give up after 3 consecutive UNAUTH errors

export class WsClient {
  constructor({ url, deviceId, token, getToken, getCursors, onFrame, onStatus }) {
    this._url         = url
    this._deviceId    = deviceId
    this._getToken    = typeof getToken === 'function' ? getToken : () => Promise.resolve(token ?? '')
    this._getCursors  = getCursors   // () => [{convId, lastSeq}, ...]
    this._onFrame     = onFrame      // (typeId, fields) => void
    this._onStatus    = onStatus     // (status) => void
    this._ws          = null
    this._pingTimer   = null
    this._retryMs     = 500
    this._dead        = false
    this._nonce       = 0
    this._fastReconnect = false      // skip backoff on manual reconnect
    this._authFailCount = 0          // consecutive UNAUTH errors
  }

  connect() {
    if (this._dead) return
    this._onStatus('connecting')
    const ws = new WebSocket(this._url)
    ws.binaryType = 'arraybuffer'
    this._ws = ws

    ws.onopen = async () => {
      this._retryMs = 500
      this._authFailCount = 0          // reset on any successful open
      const token = await this._getToken().catch(() => '')
      const cursors = this._getCursors()
      console.log(`[WsClient] → HELLO deviceId=${this._deviceId} cursors=`, cursors)
      ws.send(mkHello(this._deviceId, token, cursors))
      this._startPing()
      this._onStatus('open')
    }

    ws.onmessage = ({ data }) => {
      try {
        const frame = decodeFrame(data)
        const type = frame[0]
        if (type === T.PING) { ws.send(mkPong(frame[1])); return }
        if (type === T.PONG) { return }
        console.log(`[WsClient] ← ${T_NAME[type] ?? type}`, frame.slice(1))
        this._onFrame(type, frame.slice(1))
      } catch (e) {
        console.warn('[WsClient] decode error', e)
      }
    }

    ws.onclose = () => {
      this._stopPing()
      this._onStatus('closed')
      if (!this._dead) {
        if (this._fastReconnect) {
          this._fastReconnect = false
          setTimeout(() => this.connect(), 100)
        } else {
          // Exponential backoff with jitter to prevent thundering herd on server restart
          const jitter = Math.random() * 1000 | 0
          setTimeout(() => this.connect(), this._retryMs + jitter)
          this._retryMs = Math.min(this._retryMs * 2, MAX_BACKOFF)
        }
      }
    }

    ws.onerror = () => ws.close()
  }

  /**
   * Force an immediate reconnect (e.g. after a token refresh).
   * Skips backoff — the next connect() will call getToken() again.
   */
  reconnect() {
    if (this._dead) return
    this._fastReconnect = true
    if (this._ws) {
      this._ws.close()  // triggers onclose → fast reconnect
    } else {
      this.connect()
    }
  }

  /**
   * Called by SyncClient when server sends ERR 401 (UNAUTH).
   * Reconnects to get a fresh token; gives up after AUTH_FAIL_MAX attempts.
   */
  notifyAuthFailed() {
    this._authFailCount++
    if (this._authFailCount <= AUTH_FAIL_MAX) {
      console.warn(`[WsClient] UNAUTH (attempt ${this._authFailCount}/${AUTH_FAIL_MAX}), reconnecting for fresh token`)
      this.reconnect()
    } else {
      console.error('[WsClient] Auth failed too many times — marking dead')
      this._dead = true
      if (this._ws) this._ws.close()
      this._onStatus('auth_failed')
    }
  }

  send(buffer) {
    if (this._ws?.readyState === WebSocket.OPEN) {
      try {
        const frame = decodeFrame(buffer)
        const type = frame[0]
        if (type !== T.PING && type !== T.PONG) {
          console.log(`[WsClient] → ${T_NAME[type] ?? type}`, frame.slice(1))
        }
      } catch {}
      this._ws.send(buffer)
    } else {
      console.warn('[WsClient] send dropped — ws not open, readyState=', this._ws?.readyState)
    }
  }

  destroy() {
    this._dead = true
    this._stopPing()
    if (this._ws) {
      const ws = this._ws
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.onopen = () => ws.close()
        ws.onerror = () => {}
      } else {
        ws.close()
      }
    }
  }

  _startPing() {
    this._pingTimer = setInterval(() => {
      this.send(mkPing(++this._nonce))
    }, PING_INTERVAL)
  }

  _stopPing() {
    clearInterval(this._pingTimer)
    this._pingTimer = null
  }
}
