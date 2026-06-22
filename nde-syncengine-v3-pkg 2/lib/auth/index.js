'use strict';
/**
 * RS256 JWT verification for WebSocket connections.
 * Monorepo issues a short-lived token (5 min) via POST /auth/ws-token.
 * We verify with the public key locally — zero network calls per connect.
 *
 * Required env: WS_JWT_PUBLIC_KEY  (RS256 PEM, e.g. "-----BEGIN PUBLIC KEY-----\n...")
 */
const { jwtVerify, importSPKI } = require('jose');

let _publicKey = null;
const _cache = new Map(); // token string -> { userId, workspaceId, role, exp }
const CACHE_MAX = 50_000;

async function _getKey() {
  if (_publicKey) return _publicKey;
  const pem = process.env.WS_JWT_PUBLIC_KEY;
  if (!pem) throw Object.assign(new Error('WS_JWT_PUBLIC_KEY not set'), { code: 500 });
  _publicKey = await importSPKI(pem.replace(/\\n/g, '\n'), 'RS256');
  return _publicKey;
}

async function verifyWsToken(token) {
  if (!token) throw Object.assign(new Error('no token'), { code: 401 });

  const hit = _cache.get(token);
  if (hit) {
    if (hit.exp > Date.now()) return hit;
    _cache.delete(token);
  }

  let payload;
  try {
    const key = await _getKey();
    ({ payload } = await jwtVerify(token, key, { algorithms: ['RS256'] }));
  } catch (e) {
    throw Object.assign(new Error('invalid token'), { code: 401 });
  }

  const result = {
    userId: payload.sub,
    workspaceId: payload.wid || null,
    role: payload.role || 'member',
    exp: payload.exp * 1000,
  };

  if (!result.userId) throw Object.assign(new Error('token missing sub'), { code: 401 });

  if (_cache.size >= CACHE_MAX) {
    // evict oldest entry
    _cache.delete(_cache.keys().next().value);
  }
  _cache.set(token, result);
  return result;
}

module.exports = { verifyWsToken };
