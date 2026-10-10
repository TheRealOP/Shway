# Shway browser adapter

`adapter.ts` is a narrow typed boundary over the running `window.filmcraft` engine. Rust keeps the
project, exact edit time, rendering, and undo history. No second timeline is maintained here.

Requires Node 26 for the dependency-free TypeScript-to-browser module build:

```sh
node --test shway/*.test.ts
node shway/build.mjs --out target/agent-foundation/web/dist
```

Build the editor first using [web setup](../docs/web.md); `cargo xtask web` recreates the distribution
directory, so generate `adapter.js` afterward. Load the emitted module from the same localhost origin:

```js
const { ShwayAdapter } = await import('/adapter.js');
const adapter = await ShwayAdapter.connect(window.filmcraft);
const { project, sequence } = await adapter.inspect();
```

Connection discovers command IDs and rejects engines that lack the proposal boundary. The registry
contains human-readable parameter descriptions; it is not itself a strict JSON schema. This adapter
and Rust's typed deserializer validate the allowlisted proposal shape.

The supported proposal steps are `timeline.trim` and `clip.replaceFromBin`. Proposals explicitly name
expected revision, active sequence, target clips, source IDs, and frame deltas. Requests are limited
to 16 steps, 32 total explicit target references, and labels of at most 120 UTF-8 bytes. Rust stages them in a
disposable session. `previewFrame` returns bounded RGBA pixels from that candidate without changing
the authoritative timeline. Explicit pending media responses retry for at most five seconds. Real
source/decode failures, stale revisions and changed interaction context remain actionable errors.

`commit` makes one normal undoable edit; `cancel` discards the candidate. Seek and normal controls
remain available. A newer edit is preserved when a stale proposal is rejected or discarded.

The adapter also exposes `select`, `seekFrame`, `play`, `stop`, `undo`, H.264/AAC `export`, and `jobs`.
There is no public arbitrary model-command passthrough. Playback and export operate on the accepted
project; staged candidates are inspected/rendered through their token.

Current limitations: finite media sources, synchronized linked A/V, normal speed, no reverse, frame
hold, multicamera, nested sequence or subclip targets. Proposals whose exact trim exceeds handles or
whose replacement is shorter than the retained clip are rejected for replanning. A candidate frame
API is available; no full gesture/voice interface or real-time candidate playback is claimed.

Run the real browser integration with generated source, alternative and short fixtures served next
to the editor's index:

```sh
ffmpeg -hide_banner -loglevel error -y -f lavfi -i color=c=purple:size=320x180:rate=24 -f lavfi -i sine=frequency=880:sample_rate=48000 -t 4 -c:v libx264 -preset fast -pix_fmt yuv420p -c:a aac target/agent-foundation/web/dist/alternative.mp4
ffmpeg -hide_banner -loglevel error -y -f lavfi -i color=c=green:size=320x180:rate=24 -f lavfi -i sine=frequency=220:sample_rate=48000 -t 1 -c:v libx264 -preset fast -pix_fmt yuv420p -c:a aac target/agent-foundation/web/dist/short.mp4
node apps/filmcraft-web/tests/foundation.mjs --url http://127.0.0.1:8765/ --media web-test.mp4 --out target/agent-foundation/web/proposals --proposals
```

## Transcripts and takes (DEV-88)

`takes.ts` holds a provider-neutral word-timed transcript format and a take index; no
transcription provider is chosen. One JSON object per recorded source item:

```json
{"sourceItemId": 41, "timeUnit": "seconds", "language": "en",
 "words": [{"text": "Welcome", "start": 0.5, "end": 0.9, "confidence": 0.93}]}
```

`timeUnit` is `seconds` or `ticks` (no default). `parseTranscript` rejects unknown fields, NaN,
infinities, negative/fractional ticks, unordered or overlapping words, empty or >100-character
words, more than 20,000 words, and times that do not convert to exact safe-integer ticks
(254,016,000,000 per second, rounded once at this boundary). `adapter.importTranscript(input)`
validates before any await, requires a Movie/Audio project item whose duration covers every word,
then calls the engine's `transcript.set` (`{item, transcript: {language, words}}`) as one undoable
"Set Transcript" edit, replacing that item's earlier transcript.

`indexTakes(transcripts, script, minScore = 0.6)` groups word ranges into takes per script
statement: for each start word it takes the best window up to 1.25× the statement length, scored
by Dice overlap of normalized tokens, then accepts candidates greedily by score without overlap.
Each `Take` is `{sourceItemId, sourceIn, sourceOut, words, statementIndex, score}`; `sourceIn`/
`sourceOut` are source-media ticks of the first word start and last word end, never timeline
clip IDs or sequence time. Linked audio and multi-source sync are not indexed.

```sh
node --test shway/*.test.ts
node apps/filmcraft-web/tests/foundation.mjs --url http://127.0.0.1:8765/ --media web-test.mp4 --out target/web/transcripts --transcripts
```

See [foundation evidence](../docs/wiki/foundation-evidence.md) and the
[architecture contract](../docs/wiki/architecture.md). Never commit fixtures or generated output.

## Gemini proxy (creative reasoning)

`shway/gemini-server.mjs` is a local proxy, so the API key never reaches a web page. Node ≥ 22, no
packages.

```sh
node shway/gemini-server.mjs --port 8790      # reads GEMINI_API_KEY (optional GEMINI_MODEL) from <main checkout>/.env
```

- **Key file:** the `.env` lives beside the main checkout (found through `git rev-parse --git-common-dir`),
  so every worktree uses one file. `SHWAY_ENV=/path/.env` overrides it. `.env` is excluded from git.
- **`POST /generate`:** body `{prompt, system?, schema?, model?}`. It returns `{model, usage, text}`,
  or `{model, usage, json}` when you pass a `schema`. A `schema` is a Gemini `responseSchema`
  (OpenAPI subset: `OBJECT`, `STRING`, …).
- **`POST /transcribe`:** body `{mimeType, data}`. `mimeType` is `audio/webm`, `audio/ogg`,
  `audio/mp4` or `audio/wav`; a codec parameter such as `;codecs=opus` is allowed. `data` is base64.
  The route sends the audio inline to Gemini with an instruction to transcribe verbatim and returns
  `{model, usage, text}`. Request bodies may be up to 10 MB on this route only.
- **`GET /health`:** returns `{ok, model}`.
- **Default model:** `gemini-3.8-flash`. It calls `models/{model}:generateContent` with the key in the
  `x-goog-api-key` header.
- **Safety:** only pages served from this machine (localhost, 127.0.0.1, [::1]) may call it.
  Bodies over 2 MB are refused (10 MB for `/transcribe`). The proxy keeps reading an upload up to
  4× the limit, so the client receives the 413 response instead of a broken pipe. Upstream errors never echo the key.
- **Verified 2026-10-10:** 9 tests against a fake upstream. One live structured call with the real key:
  a three-take choice returned `{take, reason}` JSON.
- **Verified 2026-10-10 (DEV-92):** 11 tests against the fake upstream. One live `/transcribe` call
  sent a macOS `say` recording of "That sounds rehearsed. Use the take where I laugh." as WAV.
  The proxy returned that sentence exactly.

## Take replacement (DEV-92)

`replace.ts` turns a spoken correction about the selected clip into a previewed, reversible take
replacement. Build `replace.js` beside `adapter.js` with `node shway/build.mjs --out <dist>`.

```js
import {proposeReplacement, geminiGenerate, transcribe} from "/replace.js";
utterance.transcript ??= await transcribe(utterance.audio);          // {text} via POST /transcribe
const r = await proposeReplacement({utterance, takes, generate: geminiGenerate(), adapter});
// takes = indexTakes(transcripts, script); optional overrides: transcript (string), context
if (r.status === "preview") { /* show r.label, r.explanation; then */ await adapter.commit(r.token); /* or adapter.cancel(r.token) */ }
else showMessage(r.message);  // "need-selection" | "no-take" | "rejected"
// After a commit, adapter.undo() removes the whole replacement in one step.
```

`proposeReplacement` works in these steps:

1. **Context:** it reads `utterance.context` (`{revision, sequence, selection}`), the snapshot taken
   when push-to-talk started.
2. **Target:** the selection must be exactly one clip, or that clip's linked A/V pair. With no
   clip or several clips selected it returns `need-selection` and does not call the model.
3. **Current take:** it maps the clip to the indexed take whose source range overlaps the clip's
   range the most.
4. **Choice:** Gemini sees the other takes of the same statement only as numbers with their words,
   never as IDs or times. It must answer with a schema-checked index. An answer that is out of
   range, not an integer, the current take, or `-1` (none fits) returns `rejected`, and nothing is
   staged.
5. **Steps:** the chosen take covers whole frames: the first frame at or before its first word,
   through the last frame at or after its last word.
   - A take in the same source item needs two ripple trims, which slip and resize the clip in
     place. The order keeps every intermediate range valid.
   - A take in another source item first gets a ripple Out trim if it is shorter. Then comes
     `clip.replaceFromBin` (no `keepSourceIn`) and the same two trims.
   - Ripple trims shift later clips, so the new take's length is kept exactly.
6. **Preview:** the steps go to `adapter.preview` with the snapshot's revision. If the staged clip
   does not have the expected item, source In and duration, the preview is cancelled and the result
   is `rejected`.

Errors from `adapter.preview` are passed through unchanged for re-planning. These include a stale
revision or interaction context (`AdapterError` code `stale`), a source too short for the take
(`clip range must be positive and contained in its source`), missing handles, and sync locks.

Limitations: `project.inspect` does not expose source marks, so a replacement item with a source
In mark stages a range other than the take. The staged-range check then cancels the preview. A
take ending in the last partial frame of its media can be rejected by the engine. Ripple trims
follow the engine's sync-lock rules, and a locked track refuses the edit.

Evidence (2026-10-10):

- **Tests:** `node --test shway/replace.test.ts` runs 8 tests with a fake model and adapter. They
  cover the happy path, a take in another item, an earlier take, missing, several or unknown
  selections, invented, current and declined takes, a missing transcript or take, stale-revision
  and engine-error passthrough, and a staged-range mismatch. Mutation check: removing any of 22
  guards fails at least one test.
- **Live model:** for "That sounds rehearsed; use the take where I laugh", Gemini picked the
  `[laughs]` take out of three.
- **Real browser engine:** a prebuilt web dist ran with generated fixtures. `takes.mp4` holds
  three 4 s color takes and `other-take.mp4` is a 3 s alternative. A hand-written transcript was
  imported and the take index built.
  - Selecting the clip and running the demo line through live Gemini produced a preview with
    ripple trims +85 Out and +103 In.
  - The authoritative timeline and history were unchanged until commit.
  - The candidate frame rendered green, which is the laughing take.
  - Commit made one undo step labelled `Replace take: …`, and `undo()` restored the original.
  - Selecting the audio half and choosing the other source item staged a trim, `replaceFromBin`
    and two more trims. The frame rendered yellow, commit and a single undo worked, and cancel left
    the timeline unchanged.
  - An edit made after the snapshot raised `AdapterError/stale`, and an empty selection returned
    `need-selection`.
- **Not verified:**
  - A live microphone utterance through the demo page.
  - Replacement items with source marks.
  - Projects with sync-locked tracks. The demo project's A2 sync lock refused a replacement in
    the demo agent's run.
