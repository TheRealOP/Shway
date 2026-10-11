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

The supported proposal steps are `timeline.trim`, `clip.replaceFromBin`, `timeline.place`,
`timeline.remove` (`{clips}`: ripple delete with linked partners), `timeline.move`
(`{clip, anchor, position: "before"|"after"}`: rearrange on one track; counts as two references) and
`sequence.applyVideoTransition` (`{clip, effect: "split"|"push"|"iris_round", edge: "in"|"out",
direction?: "left"|"right"}` for push: a two-sided transition at that cut), `clip.zoomRegion`
and `editor.command {id, clips, args}` from the runtime `proposal.tools` catalog. Proposals explicitly name
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

Current trim/replacement limitations: finite media sources, synchronized linked A/V, normal speed,
no reverse, frame hold, multicamera, nested sequence or subclip targets. Ordinary command previews
can change speed/reverse and hold through their separately validated tools. Proposals whose exact trim exceeds handles or
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
- **Assembly:** `const preview = await assembleFirstCut(adapter, plan)` reads the active sequence
  and its `settings.frame_rate`. It widens each range outward with `alignRange` and stages the
  ranges, in script order, after the sequence's content via `adapter.assemble` (`timeline.place`,
  V1 + linked A1). Then `adapter.commit(preview.token)` (one undo step) or `adapter.cancel(...)`.
  Use an empty sequence for a clean cut. It needs an active sequence and 1–32 ranges. A last word
  that ends exactly at the source end can widen past it and be refused.

## Gemini proxy (creative reasoning)

`shway/gemini-server.mjs` is a local proxy, so the API key never reaches a web page. Node ≥ 22, no
packages.

```sh
node shway/gemini-server.mjs --port 8790      # reads GEMINI_API_KEY (optional GEMINI_MODEL) from <main checkout>/.env
```

- **Key file:** the `.env` lives beside the main checkout (found through `git rev-parse --git-common-dir`),
  so every worktree uses one file. `SHWAY_ENV=/path/.env` overrides it. `.env` is excluded from git.
- **`POST /generate`:** body `{prompt, system?, schema?, model?, images?}`. It returns `{model, usage, text}`,
  or `{model, usage, json}` when you pass a `schema`. A `schema` is a Gemini `responseSchema`
  (OpenAPI subset: `OBJECT`, `STRING`, …). `images` contains up to eight `{mimeType: "image/png"|"image/jpeg",
  data: base64}` images, at most 6 MB combined, sent inline in order before the prompt; bodies
  may be up to 9 MB on this route.
- **`POST /transcribe`:** body `{mimeType, data}`. `mimeType` is `audio/webm`, `audio/ogg`,
  `audio/mp4` or `audio/wav`; a codec parameter such as `;codecs=opus` is allowed. `data` is base64.
  The route sends the audio inline to Gemini with an instruction to transcribe verbatim and returns
  `{model, usage, text}`. Request bodies may be up to 10 MB on this route only.
- **`GET /health`:** returns `{ok, model, jev}`.
- **`POST /decide`:** with `JEV_KEY` in the `.env`, forwards `{state, questions, model?}` (1–8 questions;
  the model must be `jev-*`, default pinned `jev-1.13.0`) to TypeSafe `POST /v1/systemone` with the key as a bearer
  token. Returns `{model, answers, usage}`. Without a key it returns 503. Errors never contain either key.
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

**Decider contract (DEV-104):** `prepareReplacement(input)` resolves the target and returns
`{status: "candidates", correction, context, candidates: [{id, words, current, take}], …}` without any
model call. `stageReplacement(prepared, choice, explanation, adapter)` stages only an offered `id`;
`"no-change"`, `"review"`, the current take and any other string return `rejected` and stage nothing.
Staging uses the snapshot revision, so a late decision fails as `stale`. `proposeReplacement` is
prepare → Gemini → stage. For TypeSafe Jev, the candidates map to a `choice` question's `criteria`
(`{"take-1": words, …, "no-change": …, "review": …}`). Give the model only ids and words; keep `take`
(ids and times) on this side.

**Jev decider:** `proposeReplacement({…, decide: jevDecide(proxy)})` asks TypeSafe Jev through the proxy's
`POST /decide`. Jev sees the correction, the current take's words, and the other takes as named
choices plus `no-change`/`review`. An answer below `minConfidence` (default 0.6) becomes `review`.
The demo page uses Jev whenever `/health` reports `jev: true`, and Gemini otherwise.
- **Verified 2026-10-10 (`jev-latest` → `jev-1.13.0`):** "our workshop" → take-2 (0.99), "less hesitant"
  → the clean take (0.93), "fade to black" → review (0.96), each in about 0.2 s over the API.
- **In the browser engine** (`foundation.mjs --creator --decider jev`, 2 runs): Jev chose "our workshop" at
  0.97. The whole decision through to the preview took 252 / 288 ms (Gemini: 2.3–4.0 s). For the replayed TRIBE
  event, Jev's confidence was 0.47 / 0.51, so the result was review and nothing changed.
  All gates passed (21 chain + 15 foundation).

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

## Local word-timed transcripts (DEV-88)

`shway/transcribe-local.mjs` runs FilmCraft's built-in Whisper (pure Rust, candle, CPU) headlessly
and writes a `TranscriptInput` (`timeUnit: "ticks"`) for `parseTranscript` /
`adapter.importTranscript`. No paid provider, no network after the one-off model download. Node ≥ 22.

```sh
cargo build --release -p filmcraft-cli --features whisper      # speech is off in default builds
node shway/transcribe-local.mjs clip.mp4 --download --out clip.transcript.json   # first run only: --download
node shway/transcribe-local.mjs clip.mp4 --source-item 41 --language en --out clip.transcript.json
node --test shway/transcribe-local.test.mjs
```

- **Flow:** `filmcraft-cli import` into a throwaway project, `exec transcript.generate`, then the
  engine's stored transcript (`project.transcripts[id]`, media-time ticks) is exported as is.
  Blank words are dropped; malformed or overlapping bounds fail the run instead of being guessed.
- **`--source-item`:** the item id in the project the transcript will be imported into (default:
  the throwaway project's id, which is 1). **`--model`:** `whisper-tiny` | `whisper-base` (default) |
  `whisper-small`. **`--language`:** `auto` (default) or an ISO code. **`--cli`:** default
  `target/release/filmcraft-cli`.
- **Model:** `--download` runs `transcript.downloadModel`: pinned OpenAI Hugging Face revisions,
  SHA-256 checked, into `$FILMCRAFT_DATA_DIR` or `~/Library/Application Support/FilmCraft/models`.
  whisper-base is 293 MB (tiny 154 MB, small 969 MB). Licence: MIT (OpenAI weights), HF conversion
  Apache-2.0. Never commit weights.
- **Verified 2026-10-10 (Apple M2):** `say` speech, 5.37 s, as mp4 and wav fixtures made by ffmpeg.
  All 16 words were correct, with monotonic times from 0.05 s to 5.34 s. The ffprobe duration is
  5.375 s. The first run took 20 s, including the download. Later runs took 4.8 s wall, including
  the model load. `parseTranscript` accepted the output. `indexTakes` found all three script lines
  at score 1.00. The built-in recogniser sets no confidence (every word gets 1), so do not rank takes on
  confidence. Real creator footage, noisy audio and clips over 30 s are not yet verified.

## Long-form first cut from many clips (`longform.mjs`)

`node shway/longform.mjs segments|plan|assemble|compare|test` (usage in the file header). Splits
`transcribe-local.mjs` transcripts into word-exact segments at pauses, asks Gemini (local proxy,
segment numbers + text + one-line clip descriptions, never times) for a hook/intro/body/ending
playlist, validates it (numbers exist, no duplicates, 500–1600 spoken words; one retry quoting the
error), widens ranges to whole frames with `alignRange`, and places them with `proposal.preview` →
`proposal.commit`. The engine caps a proposal at 32 ranges, so a longer cut commits as several
labelled proposals. Needs a CLI built from this tree (`proposal` `timeline.place` steps).

## Chat assistant (`assistant.mjs`)

A local service that lets the creator chat with the AI that edits their video in the desktop editor.
It needs Node 23 or later, because it imports `adapter.ts` and `replace.ts`. It has no package dependencies.

```sh
filmcraft --control 9876 project.fcproj                 # the desktop editor
node shway/gemini-server.mjs --port 8790                # holds the Gemini / Jev keys
node shway/assistant.mjs --port 8793 --editor 127.0.0.1:9876 --proxy http://127.0.0.1:8790 [--takes takes.json]
node --test shway/assistant.test.mjs                    # fake editor (TCP) + fake proxy
```

**Contract.** The service listens on loopback only and refuses non-local `Origin` headers. JSON bodies are at most 64 KB.

| Route | Body | Returns |
|---|---|---|
| `GET /chat/state` | – | `{messages: [{role: "user"\|"assistant", text}], pending: null\|{token, label}, busy}` |
| `POST /chat` | `{message}` (1–2000 chars) | `{reply, pending, busy}` |
| `POST /chat/accept` | `{}` or empty | commits the pending preview (one undo step); same shape |
| `POST /chat/reject` | `{}` or empty | cancels it; same shape |

- **Errors:** a non-2xx status with `{error}`. While a request is running, POSTs return 409.
  Accept or reject with nothing pending also returns 409. An unreachable editor or proxy returns 502.
- **Memory:** the conversation is kept in memory only and capped at 200 messages.

**How a message becomes an edit:**

1. The service cancels any older pending preview, because the engine holds one at a time.
2. It inspects the project: the active sequence's clips with their file names, start and duration in
   seconds, selection, playhead and fps. Where the project has transcripts it adds the words from
   `transcript.inspect`. The model gets this as JSON data, never as instructions. Linked audio is
   folded into its video clip.
3. Gemini (`POST {proxy}/generate` with a response schema) picks one action from the allowlist. Each
   action has its own nested object, and every field in it is required: `answer`, `remove{clips}`,
   `trim{clip, edge, direction, amount, unit}`, `move{clip, target, position}`,
   `replace_take{correction}`, `edit{steps}` (approved commands with explicit clips and `argsJson`),
   `navigate{operation,value}` and, only while a finished sketch is shown,
   `transition{from, to, effect, direction}` or `zoom{clip, region, factor}`.
4. Validation rejects any other field, unknown clip ids, amounts that are not positive, trims past
   the clip length or the media handles, and moves onto the same clip, its linked partner or another
   track. An invalid answer gets one
   retry that quotes the error. If that also fails, the creator gets a polite "couldn't" reply.
5. Code maps the checked fields to engine params. Model command names must be in `proposal.tools`;
   target-free arguments pass both envelope checks and authoritative Rust type/range checks.
   Files, jobs and preferences are excluded.
6. Edits go only through `proposal.preview` with `expectedRevision`. A trim is a ripple
   `timeline.trim` of `round(seconds × fps)` frames. A remove is a `timeline.remove {clips}` step
   (ripple delete; linked audio goes with its video). A move is a `timeline.move {clip, anchor:
   target, position}` step (the clip plays right before/after the target; the rest ripples, length
   unchanged). If the engine refuses a step (sync-locked music under the cut, a gap that would also
   close, locked tracks), the creator gets its reason and nothing changes. `replace_take` calls `proposeReplacement` on
   the selected clip with the `--takes` index. It uses Jev when the proxy reports `jev: true`, and
   Gemini otherwise. Nothing commits until `/chat/accept`.
7. A stale revision, at preview or at accept, cancels the preview and asks the creator to retry.

**Freehand + explanation.** With a finished sketch (`drawing: false`), a chat or review note sends
the Program monitor screenshot, full ordered normalized strokes, project context and explanation
together to `gemini-3.1-pro-preview`. There is no shape classification step. The model chooses one
validated supported action or asks for clarification. An explicit transition chooses its effect
(`split|push|iris_round`) and direction; code stages a move first if needed.
A circled region plus “zoom 2x here” stages `clip.zoomRegion {clip, region, factor}`, composing
the existing Motion controls for the whole current video clip. It is a static zoom/recenter,
not animated camera movement. Animated/disabled Motion is refused. First nonempty ink pauses and
captures the frame/project target; stale frames or changed ink during inference cannot stage.
Screenshot files are deleted after reading and capped at 6 MB. Accept/Reject consumes the submitted
ink; newer strokes remain. See the [interaction contract](../docs/wiki/interactions.md#freehand-drawing--explanation-2026-10-11)
and [verification evidence](../docs/wiki/acceptance.md#freehand-intent-and-region-zoom-2026-10-11).

**Ordinary tools.** `GET /chat/tools` exposes the runtime catalog: 62 generic commands, including
effects/parameters/keyframes, speed/reverse, gain/volume, timeline adjustments/nudges, framing,
graphics, captions and essential-sound tags. The whole batch stages atomically and commits as one
undo entry. Coverage is 57 / 89 core project-editing registry entries, including shortcut aliases;
the catalog also reports all 121 core entries and the 32 excluded IDs. There are 180 applicable
video/audio effect definitions. Selection-dependent availability describes current editor state;
explicit targets are validated again during staging. See the
[coverage and limits](../docs/wiki/interactions.md#ordinary-tools-and-transition-inspection).

**Rendered transition review.** After staging a transition, `preview.mjs` renders five ordered
128-pixel candidate frames around the cut and sends those images/timestamps to vision. A rejected,
invalid or stale inspection cancels the candidate. Successful pending state includes the inspection
summary; `GET /chat/preview` returns the same token's timed images for `surface/review.html`.
The UI labels sampled still frames accurately; it does not claim continuous playback or audio
inspection. The creator still accepts or rejects the proposal.

**Not supported yet:**

- **Rearranging a group as one move:** the adjacency move action names one clip (with its links).
  Explicit multi-step batches and some fixed nudges are available; group-level rearrangement needs
  a separate contract.
- **Restarts:** a pending preview is not cancelled when the service restarts. The engine then
  refuses new previews until that token is cancelled or the app restarts.

**Verified 2026-10-10 (live).** Setup:

- A release `filmcraft --control 9878` ran on a copy of `longform-chrono.fcproj`: 53 linked clips at 59.94 fps.
- The 20 word transcripts were imported first through `transcript.set`, giving 20 setup undo steps.
- The run used a real Gemini proxy (`gemini-3.8-flash`) and `curl`-style requests.

Results:

| Message | Latency | Result |
|---|---|---|
| A question about the video | 4.5 s | Summarized the vlog and named the Chili's clips (104, 107) |
| "remove the Chili's part" | 5.9 s | Unsupported reply; nothing changed |
| "trim the end of the first clip by 1 second" | 3.9 s | Previewed a 60-frame ripple trim; history unchanged |
| Reject | 0.00 s | Discarded; history unchanged |
| The same trim again | 3.3 s | Previewed |
| Accept | 0.08 s | Undo count 20 → 21 (`Trim end of C5500.MP4 (shorten 60 frames)`); sequence 37130 → 37070 frames |
| Undo, then redo | – | Undo restored exactly 37130 frames; redo reapplied the trim |
| "move the Chili's part to the very start" | 29.8 s | Gemini answered and asked which single clip to move; nothing changed |
| "make the start of the second clip 10 frames tighter" | 3.2 s | Previewed and accepted as one step, after a `playhead.set` in between |
| "use the take where I laugh" | 17.2 s | With no selection, asked the creator to select a clip |
| Accept after the creator undid in the app | – | Stale: "didn't apply it"; nothing committed |
| A request with an `https://evil.example` origin | – | 403 |

Every Gemini answer in the run passed validation on the first try. An earlier flat schema failed:
the model dropped or invented trim fields, which is why each action now has a nested object.
The `replace_take` path with a real take index was not exercised live; its unit tests are in `replace.test.ts`.

**Remove/move verified 2026-10-10 (live).** Same setup on a fresh copy: `filmcraft --control 9879`,
proxy `:8799`, assistant `:8797`, 20 transcripts imported (undo 20). After load the sequence was
37060 frames, 53 linked pairs, no gaps. The "Unsupported reply" and "asked which single clip" rows
above predate the remove and move steps.

| Message | Latency | Result |
|---|---|---|
| "remove the Chili's part" | 90.2 s | Gemini proxy timed out; 502, nothing changed |
| The same again | 40.7 s | Previewed `Remove C5515.MP4, C5515.MP4`: clips 104, 107 and their audio 105, 108; `closed` 503 frames; history unchanged |
| Accept | 0.01 s | Undo 20 → 21; 37060 → 36557 frames (−503); 51 V1/51 A1, all linked and aligned, no gaps |
| Undo / redo / undo | – | Undo restored 37060 frames and 53 pairs; redo gave the same sequence byte-for-byte as the accept; undo again was identical to the first undo |
| "move the Chili's part to the very start of the video" | 26.4 s | Previewed `Move C5515.MP4 before C5500.MP4` (clips 104 and 105 to 0) |
| Reject | 0.01 s | Discarded; sequence identical to before; undo still 20 |
| "move the second clip so it plays after the fourth clip" | 5.3 s | Previewed |
| Accept | 0.02 s | Undo 20 → 21; V1 order 29, 32, 35, 38 → 29, 35, 38, 32; clip 41 onward unchanged; 37060 frames; linked, aligned, no gaps |
| Undo | – | Sequence identical to before the move |
