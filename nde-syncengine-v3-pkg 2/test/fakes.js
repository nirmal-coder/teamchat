'use strict';
/**
 * Minimal in-memory fakes for the subset of Redis + Mongo the engine uses.
 * Lets the full Storage + SyncEngine run end-to-end with zero external deps.
 */

class FakeRedis {
  constructor() { this.kv = new Map(); this.sets = new Map(); this.streams = new Map(); this.zsets = new Map(); this.hashes = new Map(); }
  async ping() { return 'PONG'; }
  async incr(k) { const v = (Number(this.kv.get(k)) || 0) + 1; this.kv.set(k, v); return v; }
  async incrby(k, n) { const v = (Number(this.kv.get(k)) || 0) + Number(n); this.kv.set(k, v); return v; }
  async get(k) { return this.kv.has(k) ? String(this.kv.get(k)) : null; }
  async set(k, v) { this.kv.set(k, v); return 'OK'; }
  async del(k) { this.kv.delete(k); return 1; }
  async exists(k) { return this.kv.has(k) ? 1 : 0; }
  async sadd(k, ...m) { if (!this.sets.has(k)) this.sets.set(k, new Set()); const s = this.sets.get(k); let added = 0; for (const x of m) { if (!s.has(x)) { s.add(x); added++; } } return added; }
  async srem(k, ...m) { const s = this.sets.get(k); if (!s) return 0; let n = 0; for (const x of m) { if (s.delete(x)) n++; } return n; }
  async smembers(k) { return [...(this.sets.get(k) || [])]; }
  async sismember(k, m) { return (this.sets.get(k) && this.sets.get(k).has(m)) ? 1 : 0; }
  async scard(k) { return (this.sets.get(k) || new Set()).size; }
  // sorted sets (score -> member)
  async zadd(k, score, member) {
    if (!this.zsets.has(k)) this.zsets.set(k, new Map());
    this.zsets.get(k).set(member, Number(score)); return 1;
  }
  async zrangebyscore(k, min, max, ...rest) {
    const z = this.zsets.get(k); if (!z) return [];
    let limitOffset = 0, limitCount = Infinity;
    const limitIdx = rest.indexOf('LIMIT');
    if (limitIdx !== -1) { limitOffset = Number(rest[limitIdx + 1]); limitCount = Number(rest[limitIdx + 2]); }
    const minN = min === '-inf' ? -Infinity : Number(min);
    const maxN = max === '+inf' ? Infinity : Number(max);
    const entries = [...z.entries()].filter(([, s]) => s >= minN && s <= maxN).sort((a, b) => a[1] - b[1]);
    return entries.slice(limitOffset, limitOffset + limitCount).map(([m]) => m);
  }
  async zremrangebyrank(k, start, stop) {
    const z = this.zsets.get(k); if (!z) return 0;
    const sorted = [...z.entries()].sort((a, b) => a[1] - b[1]);
    const len = sorted.length;
    const s = start < 0 ? Math.max(0, len + start) : start;
    const e = stop < 0 ? Math.max(-1, len + stop) : Math.min(stop, len - 1);
    let removed = 0;
    for (let i = s; i <= e; i++) { z.delete(sorted[i][0]); removed++; }
    return removed;
  }
  // hashes
  async hset(k, field, value) { if (!this.hashes.has(k)) this.hashes.set(k, new Map()); this.hashes.get(k).set(field, value); return 1; }
  async hget(k, field) { const h = this.hashes.get(k); return h ? (h.get(field) || null) : null; }
  async hmget(k, ...fields) { const h = this.hashes.get(k); return fields.map((f) => h ? (h.get(f) || null) : null); }
  async xadd(k, ...args) {
    if (!this.streams.has(k)) this.streams.set(k, []);
    const star = args.indexOf('*');
    const fields = star === -1 ? args : args.slice(star + 1);
    const id = `${Date.now()}-${this._xseq = (this._xseq || 0) + 1}`;
    this.streams.get(k).push([id, fields]);
    return id;
  }
  async xrange(k, start, end, countTok, count) {
    const s = this.streams.get(k) || [];
    return count ? s.slice(0, Number(count)) : s.slice();
  }
  async xtrim(k, strat, n) {
    const s = this.streams.get(k); if (!s) return 0;
    if (Number(n) === 0) { const len = s.length; s.length = 0; return len; }
    return 0;
  }
  pipeline() {
    const ops = []; const self = this;
    const p = {
      set: (k, v, ...rest) => (ops.push(['set', k, v, ...rest]), p),
      sismember: (k, m) => (ops.push(['sismember', k, m]), p),
      exists: (k) => (ops.push(['exists', k]), p),
      sadd: (k, ...m) => (ops.push(['sadd', k, ...m]), p),
      zadd: (k, score, member) => (ops.push(['zadd', k, score, member]), p),
      zremrangebyrank: (k, start, stop) => (ops.push(['zremrangebyrank', k, start, stop]), p),
      hset: (k, field, value) => (ops.push(['hset', k, field, value]), p),
      exec: async () => {
        const out = [];
        for (const [op, ...a] of ops) {
          if (op === 'set') { await self.set(...a); out.push([null, 'OK']); }
          else if (op === 'sismember') out.push([null, await self.sismember(...a)]);
          else if (op === 'exists') out.push([null, self.kv.has(a[0]) ? 1 : 0]);
          else if (op === 'sadd') out.push([null, await self.sadd(...a)]);
          else if (op === 'zadd') out.push([null, await self.zadd(...a)]);
          else if (op === 'zremrangebyrank') out.push([null, await self.zremrangebyrank(...a)]);
          else if (op === 'hset') out.push([null, await self.hset(...a)]);
        }
        return out;
      },
    };
    return p;
  }
}

class FakeCollection {
  constructor() { this.docs = new Map(); } // _id -> doc
  async createIndex() { return 'ok'; }
  async insertOne(doc) {
    if (this.docs.has(doc._id)) { const e = new Error('dup'); e.code = 11000; throw e; }
    this.docs.set(doc._id, JSON.parse(JSON.stringify(doc, bufReplacer), bufReviver));
    return { insertedId: doc._id };
  }
  async findOne(q, opts) {
    for (const d of this.docs.values()) if (this._match(d, q)) return clone(d);
    return null;
  }
  async updateOne(q, update, opts) {
    let target = null;
    for (const d of this.docs.values()) if (this._match(d, q)) { target = d; break; }
    if (!target) {
      if (opts && opts.upsert) {
        const doc = { ...(update.$setOnInsert || {}) };
        applyUpdate(doc, update);
        const id = doc._id || `${q.deviceId}:${q.convId}`;
        doc._id = doc._id || id;
        this.docs.set(id, doc);
        return { matchedCount: 0, upsertedCount: 1 };
      }
      return { matchedCount: 0 };
    }
    applyUpdate(target, update);
    return { matchedCount: 1 };
  }
  async bulkWrite(ops) {
    let nModified = 0;
    for (const op of ops) {
      if (op.updateOne) {
        const r = await this.updateOne(op.updateOne.filter, op.updateOne.update, op.updateOne);
        if (r.matchedCount) nModified++;
      }
    }
    return { modifiedCount: nModified };
  }
  async findOneAndUpdate(q, update, opts) {
    let target = null;
    for (const d of this.docs.values()) if (this._match(d, q)) { target = d; break; }
    if (!target) return null;
    applyUpdate(target, update);
    return clone(target);
  }
  find(q) {
    const all = [...this.docs.values()].filter((d) => this._match(d, q));
    let arr = all;
    const cur = {
      sort: (spec) => { const k = Object.keys(spec)[0]; const dir = spec[k]; arr = arr.slice().sort((a, b) => (a[k] - b[k]) * dir); return cur; },
      limit: (n) => { arr = arr.slice(0, n); return cur; },
      toArray: async () => arr.map(clone),
      next: async () => (arr.length ? clone(arr[0]) : null),
    };
    return cur;
  }
  aggregate(pipeline) {
    // supports a single $group max
    const groups = new Map();
    for (const d of this.docs.values()) {
      const g = pipeline.find((p) => p.$group);
      if (!g) continue;
      const key = d.convId;
      const m = Math.max(groups.get(key) || 0, d.seq);
      groups.set(key, m);
    }
    const out = [...groups.entries()].map(([_id, m]) => ({ _id, m }));
    return { toArray: async () => out };
  }
  _match(d, q) {
    for (const [k, v] of Object.entries(q)) {
      if (v && typeof v === 'object' && !Array.isArray(v) &&
          (v.$gt !== undefined || v.$gte !== undefined || v.$lt !== undefined || v.$in !== undefined)) {
        if (v.$gt !== undefined && !(d[k] > v.$gt)) return false;
        if (v.$gte !== undefined && !(d[k] >= v.$gte)) return false;
        if (v.$lt !== undefined && !(d[k] < v.$lt)) return false;
        if (v.$in !== undefined && !v.$in.includes(d[k])) return false;
        continue;
      }
      if (d[k] !== v) return false;
    }
    return true;
  }
}

class FakeMongo {
  constructor() { this.cols = new Map(); }
  collection(name) { if (!this.cols.has(name)) this.cols.set(name, new FakeCollection()); return this.cols.get(name); }
}

// Buffer survives the clone path
function bufReplacer(k, v) { 
  if (Buffer.isBuffer(v)) return { __buf: v.toString('base64') }; 
  if (v instanceof Uint8Array) return { __buf: Buffer.from(v).toString('base64') };
  if (v && v.type === 'Buffer' && Array.isArray(v.data)) return { __buf: Buffer.from(v.data).toString('base64') };
  return v; 
}
function bufReviver(k, v) { if (v && v.__buf) return Buffer.from(v.__buf, 'base64'); return v; }
function clone(d) { return JSON.parse(JSON.stringify(d, bufReplacer), bufReviver); }

function applyUpdate(doc, update) {
  if (update.$set) for (const [k, v] of Object.entries(update.$set)) setPath(doc, k, v);
  if (update.$unset) for (const k of Object.keys(update.$unset)) unsetPath(doc, k);
  if (update.$max) for (const [k, v] of Object.entries(update.$max)) doc[k] = Math.max(doc[k] || 0, v);
  if (update.$push) for (const [k, v] of Object.entries(update.$push)) { if (!doc[k]) doc[k] = []; doc[k].push(v); }
  if (update.$addToSet) for (const [k, v] of Object.entries(update.$addToSet)) { if (!doc[k]) doc[k] = []; if (!doc[k].includes(v)) doc[k].push(v); }
  if (update.$pull) for (const [k, v] of Object.entries(update.$pull)) { if (doc[k]) doc[k] = doc[k].filter((x) => x !== v); }
  if (update.$setOnInsert) { /* only on insert; handled in upsert path */ }
}
function setPath(obj, path, val) {
  const parts = path.split('.'); let o = obj;
  for (let i = 0; i < parts.length - 1; i++) { if (!o[parts[i]]) o[parts[i]] = {}; o = o[parts[i]]; }
  o[parts[parts.length - 1]] = val;
}
function unsetPath(obj, path) {
  const parts = path.split('.'); let o = obj;
  for (let i = 0; i < parts.length - 1; i++) { if (!o[parts[i]]) return; o = o[parts[i]]; }
  delete o[parts[parts.length - 1]];
}

module.exports = { FakeRedis, FakeMongo };
