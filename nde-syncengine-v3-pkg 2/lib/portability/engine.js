'use strict';
/**
 * FEATURE: Portability — engine slice. Import a WhatsApp export into a
 * conversation, and export a conversation back to WhatsApp _chat.txt format.
 *
 * Import strategy: messages are replayed through the SAME ingest path as live
 * messages, so they get real ULIDs, server seqs, and land in the durable log /
 * replay stream exactly like native messages. Imported messages are tagged
 * { imported: true, source: 'whatsapp' } and carry the original timestamp.
 *
 * Sender mapping: WhatsApp uses display names; the caller supplies a
 * nameToUserId map (e.g. { "Gunasekar": "user42" }). Unknown names are kept as
 * a stable synthetic id "wa:<name>" so nothing is lost.
 */

const F = require('../common/frames');
const { ulid } = require('../common/ulid');
const { parseChat } = require('./whatsapp');

class PortabilityEngine {
  constructor({ storage }) { this.storage = storage; }

  /**
   * Import a WhatsApp _chat.txt string into convId.
   * opts: { nameToUserId={}, includeSystem=false, dayFirst=true }
   * Returns { imported, skipped, firstSeq, lastSeq }.
   */
  async importWhatsApp({ convId, text, nameToUserId = {}, includeSystem = false, dayFirst = true }) {
    const parsed = parseChat(text, { dayFirst });
    let imported = 0, skipped = 0, firstSeq = null, lastSeq = null;
    for (const m of parsed) {
      if (m.system && !includeSystem) { skipped++; continue; }
      const senderId = m.system ? 'system'
        : (nameToUserId[m.sender] || `wa:${m.sender || 'unknown'}`);
      const contentType = m.system ? F.CT.SYSTEM : m.contentType;
      const payload = Buffer.from(m.body, 'utf8');
      const r = await this.storage.ingest({
        ulid: ulid(m.ts), convId, senderId, contentType, payload, ts: m.ts,
        imported: true, source: 'whatsapp',
        media: m.mediaPlaceholder ? { placeholder: true } : (m.filename ? { filename: m.filename } : undefined),
      });
      if (firstSeq === null) firstSeq = r.seq;
      lastSeq = r.seq;
      imported++;
    }
    return { imported, skipped, firstSeq, lastSeq };
  }

  /**
   * Export a conversation back to WhatsApp _chat.txt format.
   * opts: { userIdToName={} } to render friendly names.
   * Returns the text string.
   */
  async exportWhatsApp({ convId, userIdToName = {} }) {
    const all = [];
    let cursor = 0;
    for (;;) {
      const batch = await this.storage.range(convId, cursor, 500);
      if (!batch.length) break;
      for (const m of batch) { all.push(m); cursor = Math.max(cursor, m.seq); }
      if (batch.length < 500) break;
    }
    const lines = [];
    for (const m of all) {
      if (m.deleted || m.expired) continue;
      const d = new Date(m.ts);
      const stamp = `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${String(d.getUTCFullYear()).slice(2)}, ` +
        `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
      const body = bodyOf(m);
      if (m.contentType === F.CT.SYSTEM) {
        lines.push(`[${stamp}] ${body}`);
      } else {
        const name = userIdToName[m.senderId] || stripWa(m.senderId);
        lines.push(`[${stamp}] ${name}: ${body}`);
      }
    }
    return lines.join('\n') + '\n';
  }
}

function pad(n) { return String(n).padStart(2, '0'); }
function stripWa(id) { return id.startsWith('wa:') ? id.slice(3) : id; }
function bodyOf(m) {
  if (m.media && m.media.placeholder) return '<Media omitted>';
  if (m.media && m.media.filename) return `${m.media.filename} (file attached)`;
  if (m.payload) return Buffer.from(m.payload).toString('utf8');
  return '';
}

module.exports = { PortabilityEngine };
