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

The supported proposal steps are `timeline.trim`, `clip.replaceFromBin` and `timeline.place`. Proposals explicitly name
expected revision, active sequence, target clips, source IDs, and frame deltas. Requests are limited
to 16 steps, 32 total explicit target references, and labels of at most 120 UTF-8 bytes. Rust stages them in a
disposable session. `previewFrame` returns bounded RGBA pixels from that candidate without changing
the authoritative timeline. Explicit pending media responses retry for at most five seconds. Real
source/decode failures, stale revisions and changed interaction context remain actionable errors.

`assemble({expectedRevision, sequence, label, ranges})` builds a first cut: one `timeline.place`
step appending `ranges: [{item, sourceIn, sourceOut}]` (source ticks) in order on V1 with linked
audio on A1, after the active sequence's existing content. Ranges must lie on the sequence frame
grid; `alignRange(range, sequence.settings.frame_rate)` widens word-boundary ticks explicitly
(In down, Out up) with exact integer math. Make or activate an empty sequence first for a clean cut.

```js
const rate = sequence.settings.frame_rate;
const ranges = takes.map(t => alignRange({item: t.item, sourceIn: t.sourceIn, sourceOut: t.sourceOut}, rate));
const preview = await adapter.assemble({expectedRevision: project.revision, sequence: sequence.id, label: 'First cut', ranges});
await adapter.commit(preview.token); // one undo step; or adapter.cancel(preview.token)
```

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

## Story brief and AI first cut (DEV-89 / DEV-90)

`firstcut.ts` turns an editable brief plus the take index into a first cut. The model only
**chooses**: each candidate take is offered by an opaque number with its exact words and score, never
with times. Every `sourceIn`/`sourceOut` in the result is copied from the take index.

```js
const {parseTranscript, indexTakes} = await import('/takes.js');
const {parseBrief, planFirstCut, proxyGenerate} = await import('/firstcut.js');
const brief = parseBrief({message: "…", audience: "…", feeling: "…", durationSeconds: 30,
  requiredMoments: ["…"], exclusions: ["filler words"]});   // throws FirstCutError on bad input
const takes = indexTakes([parseTranscript(transcriptJson)], script);
const plan = await planFirstCut({brief, script, takes, generate: proxyGenerate()});
// plan.choices: [{statementIndex, take, reason}]  plan.ranges: [{item, sourceIn, sourceOut}]
// plan.skipped: statements with no indexed take (left out of the cut)
```

- **Brief:** `message`, `audience`, `feeling` (1–500 characters), optional `durationSeconds`
  (0–3600], `requiredMoments`/`exclusions` (≤20 strings). Unknown fields are rejected. The brief
  reaches the model only as JSON data, under a system rule that data is not instructions.
- **Validation:** the response must have exactly one choice per statement that has candidates, each
  naming a take that exists and belongs to that statement, with a 1–300 character reason and no
  extra fields (so no model-supplied times). Invalid output gets one retry quoting the error, then
  `planFirstCut` throws `FirstCutError`. Transport errors from `generate` propagate without retry.
- **Bounds:** ≤200 statements, ≤400 takes; take times are copied before the model call.
- `generate` is injected (`proxyGenerate(url)` posts to the local Gemini proxy and returns its `json`).

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
- **`GET /health`:** returns `{ok, model}`.
- **Default model:** `gemini-3.8-flash`. It calls `models/{model}:generateContent` with the key in the
  `x-goog-api-key` header.
- **Safety:** only pages served from this machine (localhost, 127.0.0.1, [::1]) may call it. Bodies over
  2 MB are refused. Upstream errors never echo the key.
- **Verified 2026-10-10:** 9 tests against a fake upstream. One live structured call with the real key:
  a three-take choice returned `{take, reason}` JSON.
