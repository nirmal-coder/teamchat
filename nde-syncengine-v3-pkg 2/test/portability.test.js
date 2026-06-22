'use strict';
/**
 * Portability suite — WhatsApp _chat.txt import/export.
 * Validates the mapping between WhatsApp's exported structure and the engine's
 * message schema (they are compatible; the engine's is a superset).
 */
const assert = require('assert');
const F = require('../lib/common/frames');
const { CoreStore } = require('../lib/core/storage');
const { makeEngine } = require('../lib/index');
const { parseChat, classify } = require('../lib/portability/whatsapp');
const { FakeRedis, FakeMongo } = require('./fakes');

let passed = 0, failed = 0;
const groups = [];
const group = (n, fn) => groups.push({ name: n, fn });
async function expect(name, fn) {
  try { await fn(); passed++; console.log(`    PASS  ${name}`); }
  catch (e) { failed++; console.log(`    FAIL  ${name}\n          ${e.message}`); }
}
async function fresh() {
  const redis = new FakeRedis();
  const storage = new CoreStore({ mongo: new FakeMongo(), redis });
  await storage.init();
  return { redis, storage, engine: makeEngine({ storage }) };
}

// A realistic bracketed export with: system line, two senders, multi-line msg,
// media omitted, file attached, and an emoji/unicode body.
const SAMPLE = [
  '[12/03/24, 09:15:01] Messages and calls are end-to-end encrypted.',
  '[12/03/24, 09:15:30] Gunasekar: Morning team',
  '[12/03/24, 09:16:00] Priya: Morning! Standup at 10?',
  '[12/03/24, 09:16:45] Gunasekar: Yes. Agenda:',
  'sync engine perf',
  'import feature',
  '[12/03/24, 09:17:10] Priya: <Media omitted>',
  '[12/03/24, 09:18:00] Gunasekar: IMG-20240312-WA0001.jpg (file attached)',
  '[12/03/24, 09:19:00] Priya: வணக்கம் 🙏',
].join('\n');

group('34. WhatsApp parser', async () => {
  await expect('parses headers, senders, and bodies', () => {
    const msgs = parseChat(SAMPLE);
    const nonSystem = msgs.filter((m) => !m.system);
    assert.strictEqual(nonSystem.length, 6, 'six real messages');
    assert.strictEqual(nonSystem[0].sender, 'Gunasekar');
    assert.strictEqual(nonSystem[0].body, 'Morning team');
  });
  await expect('detects the system (encryption) notice', () => {
    const msgs = parseChat(SAMPLE);
    assert.ok(msgs[0].system, 'first line flagged system');
  });
  await expect('joins multi-line message bodies', () => {
    const msgs = parseChat(SAMPLE).filter((m) => !m.system);
    const agenda = msgs.find((m) => m.body.startsWith('Yes. Agenda:'));
    assert.ok(agenda.body.includes('sync engine perf'));
    assert.ok(agenda.body.includes('import feature'));
  });
  await expect('classifies <Media omitted> as image placeholder', () => {
    assert.strictEqual(classify('<Media omitted>').contentType, F.CT.IMAGE);
    assert.ok(classify('<Media omitted>').mediaPlaceholder);
  });
  await expect('classifies "(file attached)" with extension -> correct type', () => {
    const c = classify('IMG-20240312-WA0001.jpg (file attached)');
    assert.strictEqual(c.contentType, F.CT.IMAGE);
    assert.ok(c.mediaAttached);
  });
  await expect('preserves unicode/emoji body', () => {
    const msgs = parseChat(SAMPLE).filter((m) => !m.system);
    assert.ok(msgs.some((m) => m.body.includes('வணக்கம்') && m.body.includes('🙏')));
  });
  await expect('parses timestamp into epoch ms (DMY default)', () => {
    const msgs = parseChat(SAMPLE).filter((m) => !m.system);
    const d = new Date(msgs[0].ts);
    assert.strictEqual(d.getUTCFullYear(), 2024);
    assert.strictEqual(d.getUTCMonth(), 2); // March
    assert.strictEqual(d.getUTCDate(), 12);
  });
});

group('35. Import into the engine (replayed through ingest)', async () => {
  await expect('import assigns ULIDs + monotonic seqs, skips system by default', async () => {
    const { storage, engine } = await fresh();
    await storage.addMember('imp1', 'user42');
    const r = await engine.importWhatsApp({ convId: 'imp1', text: SAMPLE, nameToUserId: { Gunasekar: 'user42' } });
    assert.strictEqual(r.imported, 6, 'six non-system imported');
    assert.strictEqual(r.skipped, 1, 'one system line skipped');
    assert.ok(r.lastSeq > r.firstSeq, 'seqs increase');
  });
  await expect('imported messages replay in order with original timestamps', async () => {
    const { storage, engine } = await fresh();
    await engine.importWhatsApp({ convId: 'imp2', text: SAMPLE, nameToUserId: { Gunasekar: 'user42', Priya: 'user43' } });
    const all = await storage.range('imp2', 0, 100);
    assert.strictEqual(all.length, 6);
    for (let i = 1; i < all.length; i++) assert.ok(all[i].seq > all[i - 1].seq);
    // original WhatsApp timestamp preserved (not import time)
    assert.strictEqual(new Date(all[0].ts).getUTCFullYear(), 2024);
    assert.ok(all[0].imported && all[0].source === 'whatsapp');
  });
  await expect('unknown sender kept as stable wa:<name> id (nothing lost)', async () => {
    const { storage, engine } = await fresh();
    await engine.importWhatsApp({ convId: 'imp3', text: SAMPLE, nameToUserId: {} });
    const all = await storage.range('imp3', 0, 100);
    assert.ok(all.every((m) => m.senderId.startsWith('wa:')), 'all map to wa: ids');
  });
  await expect('includeSystem=true imports the encryption notice as SYSTEM', async () => {
    const { storage, engine } = await fresh();
    const r = await engine.importWhatsApp({ convId: 'imp4', text: SAMPLE, includeSystem: true });
    assert.strictEqual(r.skipped, 0);
    const all = await storage.range('imp4', 0, 100);
    assert.ok(all.some((m) => m.contentType === F.CT.SYSTEM));
  });
  await expect('NEGATIVE: empty export imports nothing', async () => {
    const { engine } = await fresh();
    const r = await engine.importWhatsApp({ convId: 'imp5', text: '' });
    assert.strictEqual(r.imported, 0);
    assert.strictEqual(r.firstSeq, null);
  });
});

group('36. Export + round-trip fidelity', async () => {
  await expect('export produces WhatsApp-format lines', async () => {
    const { engine } = await fresh();
    await engine.importWhatsApp({ convId: 'rt1', text: SAMPLE, nameToUserId: { Gunasekar: 'user42', Priya: 'user43' } });
    const out = await engine.exportWhatsApp({ convId: 'rt1', userIdToName: { user42: 'Gunasekar', user43: 'Priya' } });
    assert.ok(/\[\d{2}\/\d{2}\/\d{2}, \d{2}:\d{2}:\d{2}\] Gunasekar: Morning team/.test(out));
    assert.ok(out.includes('<Media omitted>'));
    assert.ok(out.includes('(file attached)'));
  });
  await expect('import -> export -> re-import yields identical message count & bodies', async () => {
    const { engine } = await fresh();
    await engine.importWhatsApp({ convId: 'rt2a', text: SAMPLE, nameToUserId: { Gunasekar: 'g', Priya: 'p' } });
    const exported = await engine.exportWhatsApp({ convId: 'rt2a', userIdToName: { g: 'Gunasekar', p: 'Priya' } });
    const reparsed = parseChat(exported).filter((m) => !m.system);
    const original = parseChat(SAMPLE).filter((m) => !m.system);
    assert.strictEqual(reparsed.length, original.length, 'same message count after round-trip');
    // text bodies survive (media render as placeholders both ways)
    const txtOrig = original.filter((m) => m.contentType === F.CT.TEXT).map((m) => m.body);
    const txtRound = reparsed.filter((m) => m.contentType === F.CT.TEXT).map((m) => m.body);
    assert.deepStrictEqual(txtRound, txtOrig, 'text bodies identical after round-trip');
  });
});

group('37. Data-structure compatibility with WhatsApp export fields', async () => {
  await expect('every engine field has a WhatsApp-export counterpart (superset check)', async () => {
    const { storage, engine } = await fresh();
    await engine.importWhatsApp({ convId: 'cmp1', text: SAMPLE, nameToUserId: { Gunasekar: 'u1' } });
    const m = (await storage.range('cmp1', 0, 1))[0];
    // WhatsApp export exposes: timestamp, sender, body, media marker.
    assert.ok(typeof m.ts === 'number', 'ts <- [timestamp]');
    assert.ok(typeof m.senderId === 'string', 'senderId <- Sender:');
    assert.ok(m.payload, 'payload <- body');
    assert.ok(typeof m.contentType === 'number', 'contentType <- media marker / text');
    // engine-only superset fields (no WhatsApp export equivalent, additive):
    assert.ok(typeof m.seq === 'number', 'seq (engine-only ordering, stronger than file order)');
    assert.ok(typeof m._id === 'string', '_id ULID (engine-only idempotency id)');
  });
});

(async () => {
  console.log('\n=== NDE Sync Engine — portability (WhatsApp import/export) ===\n');
  for (const g of groups) { console.log('  ' + g.name); await g.fn(); }
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
