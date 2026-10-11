# Acceptance and verification

Current local results: [foundation evidence](foundation-evidence.md).

**Demo page status 2026-10-10 (DEV-93):** [surface/demo.html](../../surface/README.md) runs the
editor next to the Shway panel. Verified in Claude's browser pane with synthetic events, the PR #2
engine build and the demo project (no camera or mic): the adapter connects; swipe, step, chop and
panel Undo drive the editor; a real trim proposal previews without changing the timeline; accept by
double tap and by `A`, reject by `X`, and Undo each act once; brief validation and the missing
first-cut/replacement hooks report clearly. With `replace.js` from the DEV-92 branch (bcab4e0) and a live
Gemini call, a typed utterance reached `proposeReplacement`. It showed "select the clip" without a
selection and "no matching take" for unrelated takes. For matching synthetic takes, it showed the engine's
refusal (A2 sync lock in the demo project), so no replacement preview was staged; camera and microphone denial is reported; no horizontal
scroll at 400 px. Not verified: live camera or microphone, the still-pinch talk gesture with a real hand,
visible editor rendering (the pane was hidden, so the editor did not paint), and the first-cut and
replacement flows (their modules are not built yet).

## Complete creator workflow

- Real source footage imports, plays, edits, undoes, and exports.
- The brief produces a source-grounded first cut with synchronized dialogue.
- Twist scrubbing and swipes work without competing or resting-hand triggers.
- Gesture + speech targets the intended take and previews the requested replacement.
- One action creates one understandable undo step; cancellation restores the starting state.
- Tracking loss pauses control and requires re-engagement.
- Invalid ranges, nonfinite parameters, unsupported commands, and stale revisions cannot execute.
- The rendered export matches the accepted timeline; precise controls remain available.

## Optional layers

- Exposure and music changes are actual engine operations and survive export.
- Personalization improves the demonstrated mapping without increasing false activations
  on held-out rest traces; reset returns to baseline.
- TRIBE results belong to the exact render, have verified time alignment, and are labeled predictions.
- Viewer feedback, if collected, remains separate from neural model output.

## Test proportional to the change

For documentation-only changes: check Markdown relative links, graph nodes/targets, instruction
entry points, and the diff. Do not claim runtime or full workspace CI was run.

For Rust changes: follow upstream quality gates in [CLAUDE.md](../../CLAUDE.md) and
[contributing](../contributing.md), including required hostile-parameter and crash regression tests.
For TypeScript/Python changes: run relevant checks for modified code and the actual integration
path; add replay tests for meaningful interaction failure cases.

For UI work: inspect the rendered experience. For the core demo: run the complete source-to-export
path. Measure p95 gesture feedback separately from model latency.
Report failures and untested behavior plainly.

## Delivery

Reserve the final three hours for validation, a rehearsed live demo, backup recording,
attribution, and submission. Confirm the exact cutoff.
Use original/open assets, required sidecars, and inherited license notices.
Remove protected upstream branding from modified distributions.

## Related pages

[Wiki map](README.md) · [Implementation](implementation.md) · [Interactions](interactions.md) · [Inference](inference.md) · [Adaptation](adaptation.md)

**Integrated chain, verified 2026-10-10.**
- **Setup:** branch `claude/integration`, browser build with `timeline.place`, live `gemini-3.8-flash`
  through the local proxy, generated 25 s fixture with a hand-written transcript of 3 takes × 2 lines.
- **First cut:** brief → take index → Gemini chose one take per line, avoiding the "uh" take.
  `assembleFirstCut` staged it, and commit gave one undo step, "AI first cut".
- **Replacement:** select the line-2 clip, then the typed correction "That's too shouty. Use the calm,
  clean take…". `proposeReplacement` previewed the calm take and the real timeline stayed unchanged.
  Commit gave "Replace take: …".
- **Undo:** the first undo restored the first cut exactly. The second undo emptied the sequence.
- **Correct refusal:** asking for a take that doesn't exist returned `rejected` with Gemini's reason
  and staged nothing.
- **Not verified:** the creator's real footage, live camera and microphone, and export of the result.

**Creator chain with export, verified 2026-10-10 (main @ 90888ac + DEV-104 refactor).**
- **Media:** 17.4 s H.264/AAC fixture; speech is macOS `say` (one synthetic voice), three takes × two
  lines, with "uh"/"um" and "our workshop" variants. Picture is `testsrc2`. Not creator footage.
- **Transcript:** built-in Whisper (`whisper-base`, CPU) produced all 33 words with timings in 3.3 s.
  Nothing was hand-written.
- **Run:** `foundation.mjs --creator` in headless Chrome against a fresh `cargo xtask web` release
  build, with live `gemini-3.8-flash` through the proxy. Two runs; all 15 foundation gates and
  12 chain gates passed in both runs.
- **Chain:** take index (3 per line) → Gemini first cut chose both clean takes (plan 4.4 s / 4.0 s) →
  preview only, then one "AI first cut" undo step → the line-1 clip was selected and given the typed
  correction "I prefer the take where I say 'our workshop'" → Gemini chose that take (4.0 s / 2.3 s).
  The authoritative timeline did not change while the preview was pending, a candidate frame
  rendered, and commit gave one "Replace take" undo step.
- **Save/reopen/export:** saved, undid the replacement, then reopened the save; the timeline matched
  the accepted cut with no missing media. The H.264/AAC export (74 frames, 3.09 s) decoded cleanly.
  Whisper transcribed the downloaded export as "Welcome to our workshop. Today we build a gesture editor."
- **Not verified:** real creator footage and voices, live microphone and camera on the demo page,
  sync-locked tracks, OPFS recovery across reload.

**TRIBE event path, replayed event, verified 2026-10-10.** Same `--creator` run, after the replacement.
- **Input:** one hand-made v1 event (`renderId: "replayed-sample"`) over the line-2 clip. **This is not
  TRIBE output**; no TRIBE inference has completed.
- **Gate:** a stale revision was dropped, then the event was accepted and mapped to the line-2 clip.
  A second event with the same render and range was dropped as a duplicate.
- **Live Gemini declined twice**, correctly. One reason: "take 1 includes hesitant filler and take 2
  trails off". The indexed take had cut off "together", which is a take-index windowing limitation.
- **Fixed decider by candidate id (the Jev path):** the suggestion staged as a preview with source
  `tribe` and did not commit. The engine refused a second preview while it was pending, which is how
  we found that the page must reject before staging new creator input (fixed). The creator's proposal
  then replaced it, and rejecting restored the accepted timeline exactly.
- 21 chain gates + 15 foundation gates passed. The export still transcribes as the corrected cut.

**Review playback (DEV-113), 2026-10-11 — partly verified.** (Later on 2026-10-11 the browser page and `/review/transport` were removed; the camera now runs natively through `assistant.mjs --camera`, see [interactions](interactions.md). Voice awaits the native path.) `surface/review.html` (logic `surface/review.mjs`) is a camera/mic remote for the desktop editor via `shway/assistant.mjs` `POST /review/stop|transport|note|cancel`. Push-to-talk start is the stop (soundtrack audio is only recorded while talk is held); a leading spoken "stop" is dropped from the note, "stop" alone just stops.
- **Verified:** 16 assistant tests + 5 review tests (`node --test`); removing the stale-revision check or the resume seek fails tests.
- **Verified live** (release `filmcraft --demo --control 9881`, assistant :8799, Gemini proxy :8790): `/review/stop` paused and returned `{revision, playhead, clip}`; playback stayed paused; `/review/transport` step moved the playhead 24 frames; `/review/note` reached Gemini with "Review note at 1.29 s on clip 29, marking 1.29–2.29 s: …" shown in `/chat/state`; nothing was applied (revision unchanged).
- **Not verified:** a committed review proposal live (the demo project's sync-locked tracks made the engine refuse remove/trim; a remove refusal surfaces as 502, pre-existing /chat behaviour), resume-after-accept against the real editor (tests only), the page in a browser, camera, microphone and transcription.


## Freehand intent and region zoom, 2026-10-11

The assistant now interprets ordered normalized freehand strokes, Program monitor PNG, current
project/frame context and the creator's explanation in one vision request. No shape classifier
precedes the explanation. See the [contract](interactions.md#freehand-drawing--explanation-2026-10-11).

- Verified: local fake-editor/fake-model HTTP/TCP integration for circle + arrows + “zoom 2x”,
  typed chat and transcribed review note, supported transition choice from explanation,
  clarification without staging, hostile output/region/amount/target refusal, changed frame before
  inference, changed ink during inference, stale rendered-monitor refusal, acceptance/rejection and consuming only submitted ink.
  Repeated consumed camera ink does not pause resumed playback.
- Verified: Rust proposal tests stage a real Motion edit without publishing it, render a candidate,
  commit one history step, preserve linked audio, serialize/reopen, undo/cancel and reject stale,
  locked, audio and animated targets. The expanded render test checks that zoom changes pixels,
  accepted pixels match the candidate, and a region center maps to output center with pre-existing
  rotation, anchor and nonuniform scale.
- Limitations: the model tests use fixed responses; live vision interpretation of a camera sketch,
  creator footage, desktop screenshot/render timing and an exported zoom remain unverified.
  Zoom is static for the entire current clip, factor >1 and ≤4; animated/disabled Motion requires
  detailed controls. Unsupported commands/parameters ask for clarification instead of executing.
- The original checkout was inspected read-only: clean at 13a74ba and older than this worktree's
  drawing implementation (8e13aaa). No original-checkout files were changed. Linear status was
  read (DEV-93 Done, DEV-113 In Progress); no task status was changed.

## Ordinary tools and timed transition inspection, 2026-10-11

- Verified: runtime registry count of 62 approved generic commands; 57 / 89 core project-editing
  command entries, including aliases, with 32 explicit state/preferences/external-file exclusions
  from the 121 journaled core entries; 180 applicable video/audio effects. See the
  [coverage definition](interactions.md#ordinary-tools-and-transition-inspection).
- Verified: Rust stage/commit/one-step undo for effects, parameter animation/keyframes, gain,
  speed/reverse, framing, split/slip, nudges/volume, text/shapes and captions. Hostile tool names,
  file/preferences commands, target injection, values, effect IDs and sizes are refused. Existing
  batch atomicity and stale-token tests remain green; generic second-step failure leaves no
  candidate/history change, and a locked linked audio target blocks a volume command.
- Verified: synthetic Rust transition renders at five valid times without changing live playhead
  or project; pixels vary over time and match the committed render, then Undo restores the base.
  Fixed-model HTTP/TCP tests verify ordered frames sent to vision, inspection evidence returned
  to the user, and cancellation on rejected/invalid visual review. PNG pixels round-trip exactly.
- Verified: review page inspected in the in-app browser against a loopback mock endpoint containing
  actual synthetic Rust-rendered PNGs. Frame strip, image, timestamp and sampled-frame label render;
  this is UI fixture evidence, not live editor/provider evidence. Camera/microphone were not used.
- Not verified: live model quality, camera sketch, real creator footage, continuous transition
  motion/audio, or a new source-to-export run for this slice. Sparse frames only sample appearance.

Final gates actually run: `cargo test -p filmcraft-engine` (461 passed, 3 ignored benchmarks);
`cargo clippy -p filmcraft-engine --all-targets -- -D warnings`; `cargo fmt --check`;
`cargo xtask wasm` (42 crates), `cargo xtask layers`, `cargo xtask assets` (60 attributed assets);
`node --test shway/*.test.ts shway/*.test.mjs surface/*.test.mjs surface/gestures/*.test.mjs surface/voice/*.test.mjs`
(193 passed). Relative documentation links and `git diff --check` checked. Full workspace CI was
not run. No Linear status change was made during verification.

**Main integration, 2026-10-11.** Integrated newer native camera, held-pinch/undo-wave and typed
transition changes from main (`3cbdf0c`). The worker uses the same bounded `updateInk` ingress as
remote ink; accepting/rejecting consumes only submitted native strokes. Typed transitions retain
the rendered vision inspection. The optional browser page is a timed-image viewer only, with no
camera/microphone dependencies. Verified native callback → paused frame → multimodal proposal,
retained newer strokes/undo-wave behavior, typed transition validation and the rendered viewer
fixture. Merged suites: 182 Node tests, 461 engine tests (3 ignored), engine Clippy, formatting,
WASM (42 crates), layering and attribution passed. The smaller Node count reflects upstream
retirement of the browser review controller tests. Live camera/provider quality remains unverified.
