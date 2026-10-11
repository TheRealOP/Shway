# Plan: "make a first cut" from the in-app chat

Handoff for a cloud agent, 2026-10-11. Branch from `main`. Read `AGENTS.md`, `CLAUDE.md` and
`shway/README.md` first.

## Goal

From the desktop editor's Assistant chat, the creator types something like "make a first cut of
my footage, about 10 minutes, tell the weekend as it happened". The assistant then:
1. transcribes every bin clip that has no transcript yet,
2. has Gemini choose transcript segments, **always in recording order**,
3. stages the cut as **one** preview on a sequence. Accept applies it as one undo step; reject
   discards it.

Today this only works from the terminal (`shway/longform.mjs segments → plan → assemble`, last run
2026-10-11: 54 ranges, 12.5 min, about 2 min end to end with cached transcripts). The chat has no
action for it, and it sees transcripts only through `transcript.inspect`, which is empty for clips
imported in the app. So Gemini truthfully replies that it has no access to the clips or
transcripts.

## Constraints found (don't rediscover)

- **Control requests run on the editor UI thread** (`apps/filmcraft/src/control_server.rs` →
  channel → UI). `transcript.generate` over the control channel freezes the app for the whole
  transcription (minutes for ~35 clips). Don't do that.
- **The chat panel's HTTP read timeout is 120 s** (`crates/ui-egui/src/panels/assistant.rs:486`). The
  Gemini plan call alone took 87 s on 720 segments.
- **Proposals are capped at 32 targets** (`crates/engine/src/proposals.rs` `MAX_TARGETS`), and
  each `timeline.place` range counts as one. A real cut has 50+ ranges; longform splits it into
  several proposals, which breaks "one preview, one accept, one undo".
- The assistant's `controlTransport` defaults to a 20 s per-request timeout.
- The running desktop editor is built **without** `--features whisper`
  (`transcript.models` → `available: false`). The `whisper-base` model is already downloaded on the
  creator's Mac.
- Ordering rule (creator feedback): cuts follow **recording order** (Sony `<clip>M01.XML`
  `CreationDate`, else the QuickTime `creationdate` / `creation_time`), never a story order chosen
  by the model. Show the result on the timeline; never export unless asked.

## Design (smallest complete version)

1. **Transcribe out of process.** Inside `shway/assistant.mjs`, for each Movie/Audio bin item with no
   transcript, run `shway/transcribe-local.mjs` logic against a `filmcraft-cli` built with
   `--features whisper`. The path comes from `--cli` (default `target/release/filmcraft-cli`) and
   jobs run one at a time. Cache the results in `<FilmCraft data dir>/shway-transcripts/<sha1(path+size+mtime)>.json`.
   Then attach each one with `adapter.importTranscript` (`transcript.set`), so ordinary chat
   messages ("what does clip 3 say?") benefit too. Bin item media paths come from
   `adapter.inspect().project.root` (`binItem`).
2. **Reuse longform's pure functions; don't fork them.** Import `segment`, `chronological`,
   `recordedAt`, `validatePlan` and `toRanges` from `shway/longform.mjs`. Generalise two things:
   - `recordedAt(mediaDir, clip)` → also accept a full file path (the sidecar XML sits next to the
     MP4).
   - The `plan()` prompt is hard-coded to the ShellHacks vlog. Move the prompt into an exported
     `planPrompt({segments, brief, words})` that uses the creator's request as the brief and file
     names plus recording times in place of `clips.json` descriptions. Keep the CLI working by
     passing its old text as the brief.
3. **New chat action `first_cut`** in `SCHEMA`/`FIELDS`/`SYSTEM`/`validateAction`:
   `first_cut: {brief: string ≤ 2000, minutes: number 1–60}`. Map `minutes` to the word budget at
   ~150 words/min (±25%, clamped to the segments' total).
4. **Run it as a background job.** POST `/chat` replies immediately ("Transcribing 12 clips, then
   planning; this takes a few minutes."). The job then pushes progress and final messages into
   `messages`. Check that the panel picks them up through its existing `/chat/state` polling
   (`POLL_SECS`), and add the smallest change if it doesn't. A second `first_cut` while one is
   running gets "already working on it". Use a dedicated `controlTransport(editor, 120_000)` for
   the long engine calls.
5. **One proposal for the whole cut.** In `crates/engine/src/proposals.rs`, give `timeline.place`
   its own range cap, e.g. `MAX_PLACE_RANGES = 512` (bounded allocation), so ranges stop counting
   toward the 32 `MAX_TARGETS`. Leave every other step's cap alone. Add a Rust test that placing 100
   ranges in one proposal succeeds and 513 is refused. Update the `shway/README.md` / adapter
   docs and simplify longform's chunking only if trivial.
6. **Target sequence.** If the active sequence already has clips, first create
   `file.newSequence` "First cut" with settings taken from the first chosen clip (as longform
   `assemble` does). Then `alignRange` each range to the frame grid, clamp it to the source end
   (copy longform's clamp), and stage one `timeline.place` with `adapter.preview`. Set `pending` so
   the normal accept/reject flow applies. The reply lists the title, sections and duration.
7. **Never crash / honest errors:** no clips with audio, no Whisper CLI, transcription failure for
   one clip (skip it and say so), a plan still invalid after one retry, or a stale revision →
   each gives a clear chat reply, and nothing changes.

Skipped (YAGNI): editing an existing cut, B-roll/music, per-clip descriptions from vision, and
streaming playback of the staged candidate (accept, then watch; one undo reverts it).

## Tests / gates

- `node --test shway/*.test.mjs shway/*.test.ts`. Add cases to `shway/assistant.test.mjs` with a
  fake transport, a fake `generate` and a fake transcriber covering: action validation;
  chronological placement even when the model lists segments out of order; the background job's
  progress messages; one preview for more than 32 ranges; a failure leaving nothing changed.
- `node shway/longform.mjs test` still passes.
- Rust: `cargo fmt --check`, `cargo clippy -p filmcraft-engine --all-targets -- -D warnings`,
  `cargo test -p filmcraft-engine`, `cargo xtask layers`, `cargo xtask assets`, `cargo xtask wasm`
  (engine is below L5). Report which gates ran.
- No real footage or Gemini keys in the cloud: say plainly that the live run is unverified.

## Creator's live check (on the Mac, after merge)

```sh
cargo build --release -p filmcraft-cli --features whisper
node shway/gemini-server.mjs --port 8790 &
node shway/assistant.mjs --port 8793 --editor 127.0.0.1:9876 --proxy http://127.0.0.1:8790 --cli target/release/filmcraft-cli
cargo run --release -p filmcraft -- --control 9876
```

Import the ShellHacks clips (`~/Desktop/Shell Hacks/PRIVATE/M4ROOT/CLIP/*.MP4` and `From iphone/*.MOV`)
and ask the chat for a ~10 minute first cut. Then accept and play it back.
