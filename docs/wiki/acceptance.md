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
