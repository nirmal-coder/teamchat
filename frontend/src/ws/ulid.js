// Tiny browser-side ULID — monotonic within same millisecond
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
let lastMs = 0, lastRand = new Uint8Array(10)

export function ulid() {
  const now = Date.now()
  if (now === lastMs) {
    // increment random part
    let i = 9
    while (i >= 0 && ++lastRand[i] > 31) { lastRand[i--] = 0 }
  } else {
    lastMs = now
    crypto.getRandomValues(lastRand)
    lastRand.forEach((v, i) => { lastRand[i] = v & 31 })
  }
  let ts = now, t = ''
  for (let i = 9; i >= 0; i--) { t = ENCODING[ts % 32] + t; ts = Math.floor(ts / 32) }
  return t + Array.from(lastRand).map(v => ENCODING[v]).join('')
}
