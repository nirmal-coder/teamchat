/** Tiny browser-safe event emitter — no Node.js EventEmitter dependency. */
export class EventEmitter {
  constructor() {
    this._events = new Map()
  }

  on(event, listener) {
    if (!this._events.has(event)) this._events.set(event, [])
    this._events.get(event).push(listener)
    return this
  }

  off(event, listener) {
    const ls = this._events.get(event)
    if (!ls) return this
    const i = ls.indexOf(listener)
    if (i !== -1) ls.splice(i, 1)
    return this
  }

  emit(event, ...args) {
    const ls = this._events.get(event)
    if (!ls) return
    for (const l of ls.slice()) l(...args)
  }

  removeAllListeners(event) {
    if (event) this._events.delete(event)
    else this._events.clear()
    return this
  }
}
