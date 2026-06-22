'use strict';
/**
 * FEATURE: Portability — WhatsApp _chat.txt parser.
 *
 * WhatsApp's chat export ("Export chat" -> _chat.txt) is the only public,
 * documented data structure WhatsApp exposes. Its internal msgstore.db (SQLite
 * + Signal E2E) is proprietary and not importable; the txt export is the
 * interop surface. This parser maps each exported line into the engine's
 * message shape so it can be replayed through normal ingest.
 *
 * Line grammar (locale-dependent brackets/dates handled):
 *   [DD/MM/YY, HH:MM:SS] Sender Name: message text
 *   DD/MM/YY, HH:MM - Sender Name: message text     (alt format, no brackets)
 * System lines have no "Sender:" (e.g. "Messages are end-to-end encrypted").
 * Multi-line messages: continuation lines have no timestamp and append to prev.
 * Media: body is "<Media omitted>" or "IMG-2023....jpg (file attached)".
 */

const F = require('../common/frames');

// Two common WhatsApp header shapes. Group 1=date, 2=time, 3=rest.
const BRACKET = /^\[(\d{1,2}[\/.]\d{1,2}[\/.]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[APap][Mm])?)\]\s?(.*)$/;
const DASH    = /^(\d{1,2}[\/.]\d{1,2}[\/.]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[APap][Mm])?)\s+-\s+(.*)$/;

const MEDIA_OMITTED = /<Media omitted>|\u200e?image omitted|video omitted|audio omitted|document omitted|sticker omitted|GIF omitted/i;
const MEDIA_ATTACHED = /(IMG|VID|AUD|PTT|DOC|STK)[-_].*\(file attached\)|\(file attached\)$/i;

/** Parse "DD/MM/YY" + "HH:MM[:SS] [AM/PM]" into epoch ms (best-effort, locale DMY default). */
function parseTs(dateStr, timeStr, { dayFirst = true } = {}) {
  const d = dateStr.split(/[\/.]/).map(Number);
  let [a, b, y] = d;
  let day, month;
  if (dayFirst) { day = a; month = b; } else { month = a; day = b; }
  if (y < 100) y += 2000;
  let h = 0, min = 0, sec = 0;
  const m = timeStr.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([APap][Mm])?/);
  if (m) {
    h = Number(m[1]); min = Number(m[2]); sec = Number(m[3] || 0);
    const ap = (m[4] || '').toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
  }
  return Date.UTC(y, month - 1, day, h, min, sec);
}

function classify(body) {
  if (MEDIA_OMITTED.test(body)) return { contentType: F.CT.IMAGE, mediaPlaceholder: true };
  if (MEDIA_ATTACHED.test(body)) {
    const ext = (body.match(/\.(\w{2,4})\b/) || [, ''])[1].toLowerCase();
    const ct = ({ jpg: F.CT.IMAGE, jpeg: F.CT.IMAGE, png: F.CT.IMAGE, mp4: F.CT.VIDEO,
      opus: F.CT.AUDIO, m4a: F.CT.AUDIO, mp3: F.CT.AUDIO, pdf: F.CT.DOC, docx: F.CT.DOC })[ext] || F.CT.DOC;
    return { contentType: ct, mediaAttached: true, filename: body.replace(/\s*\(file attached\)\s*$/i, '').trim() };
  }
  return { contentType: F.CT.TEXT };
}

/**
 * Parse a full _chat.txt string into ordered message records:
 *   { ts, sender|null, body, system, ...classify() }
 * system messages (no sender) are flagged so the caller can decide whether to
 * import them as SYSTEM content or skip them.
 */
function parseChat(text, opts = {}) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let cur = null;
  for (const raw of lines) {
    // strip LRM/RLM marks WhatsApp injects
    const line = raw.replace(/[\u200e\u200f]/g, '');
    if (line === '') { if (cur) cur.body += '\n'; continue; }
    const m = BRACKET.exec(line) || DASH.exec(line);
    if (m) {
      if (cur) out.push(finalize(cur));
      const [, date, time, rest] = m;
      const ts = parseTs(date, time, opts);
      const colon = rest.indexOf(': ');
      if (colon !== -1 && !looksLikeSystem(rest)) {
        cur = { ts, sender: rest.slice(0, colon).trim(), body: rest.slice(colon + 2) };
      } else {
        cur = { ts, sender: null, body: rest, system: true }; // join/leave/encryption notices
      }
    } else if (cur) {
      cur.body += '\n' + line; // continuation of a multi-line message
    }
  }
  if (cur) out.push(finalize(cur));
  return out;
}

function looksLikeSystem(rest) {
  // System notices contain no "Name: " body but may contain colons (e.g. URLs).
  // Heuristic: known notice phrases.
  return /end-to-end encrypted|created group|added|removed|left|changed the subject|changed this group's icon|changed their phone number|security code|You deleted this message|This message was deleted/i.test(rest)
    && rest.indexOf(': ') === -1;
}

function finalize(cur) {
  // trailing blank lines (incl. the file's terminating newline) are not part
  // of the message body in WhatsApp's format; trim them.
  cur.body = cur.body.replace(/\n+$/, '');
  const cls = classify(cur.body);
  return Object.assign({ ts: cur.ts, sender: cur.sender, body: cur.body, system: !!cur.system }, cls);
}

module.exports = { parseChat, parseTs, classify };
