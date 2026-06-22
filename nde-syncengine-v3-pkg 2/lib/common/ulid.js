'use strict';
/**
 * Monotonic ULID. 48-bit ms timestamp + 80-bit randomness, Crockford base32.
 * Monotonic within the same ms so server-side ordering ties are stable.
 * Client generates these too; server treats ULID as the dedup/idempotency key.
 */
const crypto = require('crypto');
const ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

let lastTime = 0;
let lastRand = new Uint8Array(10);

function randBytes() {
  const b = crypto.randomBytes(10);
  return new Uint8Array(b);
}

function incr(rand) {
  for (let i = 9; i >= 0; i--) {
    if (rand[i] === 0xff) { rand[i] = 0; continue; }
    rand[i]++; break;
  }
  return rand;
}

function encodeTime(time, len) {
  let str = '';
  for (let i = len - 1; i >= 0; i--) {
    const mod = time % 32;
    str = ENC[mod] + str;
    time = (time - mod) / 32;
  }
  return str;
}

function encodeRand(rand) {
  // 80 bits -> 16 base32 chars
  let str = '';
  let bits = 0, value = 0;
  for (let i = 0; i < 10; i++) {
    value = (value << 8) | rand[i];
    bits += 8;
    while (bits >= 5) { str += ENC[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) str += ENC[(value << (5 - bits)) & 31];
  return str.slice(0, 16);
}

function ulid(now = Date.now()) {
  if (now === lastTime) {
    lastRand = incr(lastRand);
  } else {
    lastTime = now;
    lastRand = randBytes();
  }
  return encodeTime(now, 10) + encodeRand(lastRand);
}

module.exports = { ulid };
