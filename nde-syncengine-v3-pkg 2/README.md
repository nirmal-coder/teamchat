# @nde/syncengine v3

WhatsApp-class chat sync engine for 100K+ concurrent users. Feature-folder
architecture: a small always-on core plus self-contained feature modules that
register themselves with the engine and gateway.

## Layout
```
lib/
  common/    SHARED reusable code — import, never duplicate
             frames.js (CBOR codec + builders), ulid.js, errors.js, seq.js
  core/      always-on spine: engine.js, storage.js, gateway.js
  <feature>/ pin, poll, viewonce, disappearing, convtimer, subject
             each: engine.js + storage.js + wire.js + index.js
  index.js   composer (assembles core + features)
  server.js  bootstrap one node
  fanout.js  interest-based cross-gateway Redis Pub/Sub
test/        protocol, features, features2, concurrency, gateway, perf
```

## Run
```bash
npm install
REDIS_URL=redis://127.0.0.1:6379 MONGO_URL=mongodb://127.0.0.1:27017 \
MONGO_DB=nde_chat PORT=8090 SEQ_WINDOW=1 npm start    # run N behind HAProxy
npm test                                              # 104 checks, in-memory fakes
```
`SEQ_WINDOW>1` enables sequence batching for very hot conversations (monotonic,
may gap). Default 1 = exact, gapless.

## Reusable functions (see the Developer Reference .docx)
- `common/errors`: `EngineError`, `ensure`, `requireMember`, `requireAdmin`, `requireTarget`
- `common/seq`: `nextSeq`, `SeqBatcher`, `appendLog`
- `common/frames`: single CBOR codec + every frame builder + `T/CT/DEL/E` enums

## Performance
Conv-index O(interested) fan-out, opt-in sequence batching, pipelined offline
presence checks, per-socket backpressure + token-bucket limiting, binary CBOR
positional frames, no perMessageDeflate. Validated in test/perf.test.js.

## Adding a feature
Create `lib/<name>/` (engine/storage/wire/index), then add `require('./<name>')`
to the `FEATURES` array in `lib/index.js`. The composer wires the rest.

## WhatsApp import/export & offline sync
- Import a WhatsApp `_chat.txt` export: `engine.importWhatsApp({ convId, text, nameToUserId })`.
  Messages replay through normal ingest (real ULIDs + seqs); original timestamps preserved.
- Export back to WhatsApp format: `engine.exportWhatsApp({ convId, userIdToName })`.
- Note: WhatsApp's internal `msgstore.db` (SQLite + Signal E2E) is proprietary and
  not importable. The `_chat.txt` export is the only public interop surface; the
  engine's message schema is a *superset* of its fields (see portability tests).
- Offline -> reconnect sync: while a recipient is disconnected (server up), messages
  queue to their Redis Stream inbox; on reconnect `drainInbox` + `onHello` gap-fill
  bring them fully up to date. Verified end-to-end in test/offline.test.js.

## Tests: 124 checks, 0 failing
protocol(9) · features(38) · features2(35) · concurrency(6) · gateway e2e(10) · perf(6) · portability(15) · offline-sync(5)
