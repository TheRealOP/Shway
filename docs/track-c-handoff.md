# Track C handoff: sketch → edit (cloud session)

Written 2026-10-11 for a cloud Claude session. Branch: `claude/part-two-handoff-1897cd` (pushed). It holds
the Part 2 plan ([part-two-handoff.md](part-two-handoff.md)) plus merged Track A (ink overlay), Track B
(gesture poses/events) and the video-first layout. Node: 107/107 tests green at handoff. Rust `cargo xtask ci`
on the merge was still running when this was written: run it first and fix anything red before starting.

**Deadline:** submission ~11:00 EDT 2026-10-11. Commit by **~10:00 EDT** so the creator can merge and
rehearse on the Mac. Never leave the branch red.

## Read first

1. [AGENTS.md](../AGENTS.md), [CLAUDE.md](../CLAUDE.md), [YAGNI](wiki/yagni.md). The creator asked to
   **enforce YAGNI**: build the smallest thing that does the demo, delete rather than keep.
2. [part-two-handoff.md](part-two-handoff.md): "Sketch vocabulary" and "Track C". This file overrides it
   where they differ.
3. `shway/assistant.mjs`, `shway/gemini-server.mjs`, `crates/engine/src/proposals.rs` and their tests.

## What changed since part-two-handoff.md

- **No browser camera.** The creator wants the webcam inside the app. Another agent (on the Mac) is
  replacing `surface/review.html` with a Python worker (`shway/hands.py`) spawned by
  `assistant.mjs --camera`; recognizer events are handled **in-process** and ink goes to the editor via
  the existing `sendInk` → `ui.set {ink}` (`assistant.mjs` ~line 301). Don't touch the camera/review code,
  and keep your `assistant.mjs` edits localised (new functions + the `/chat` branch) so the merge is easy.
- **Model ids, checked against this key's model list:** sketch reading = `gemini-3.1-pro-preview`;
  action picker stays `gemini-3.8-flash` (`DEFAULT_MODEL` in `gemini-server.mjs`). Live (Track D, not
  yours) = `gemini-3.8-live`.
- **Ink state** (`crates/ui-egui/src/state.rs` `Ink`): `{pointer: [x,y]|null, strokes: [[[x,y],…],…],
  drawing: bool}`, normalised 0–1 over the frame picture, caps 20 strokes × 500 points; `ui.set {ink: null}`
  clears. `ui.screenshot {panel:"program"}` includes the ink. The draw toggle is a **thumb–index double
  tap**; when drawing turns off, the sketch stays until a decision.

## What to build (smallest version)

1. **Rust step** in `crates/engine/src/proposals.rs`: `sequence.applyVideoTransition` with
   `{clip, effect, edge}` only, effect allowlist `split | push | iris_round` (check the exact effect ids in
   `crates/render/src/transitions/legacy.rs` and what `apply_transition` in `commands.rs` accepts). It runs
   in the candidate session like the other steps. One test with the existing proposal tests, including a
   refused effect. Check that a clip keeps its id after a `timeline.move` step in the same proposal.
   *Fallback if it slips:* apply directly and make Reject run `edit.undo` after a revision check.
2. **Proxy** `/generate` in `gemini-server.mjs`: optional `images: [{mimeType: "image/png"|"image/jpeg",
   data: base64}]`, max 1 image, cap bytes; raise `MAX_BODY` (2 MB) only as far as one Program PNG needs.
   Test with the injected fetch, like the existing tests.
3. **Assistant** `/chat` with a sketch: if a finished sketch exists (strokes non-empty and `drawing` false,
   from the latest ink the assistant forwarded, no new client flag needed unless simpler):
   1. `ui.screenshot {panel:"program"}` → PNG.
   2. Vision call (`gemini-3.1-pro-preview`) with the image + strokes, schema
      `{figure: "split_outward"|"arrow_left"|"arrow_right"|"circle"|"unknown", description}`.
   3. Code maps figure → effect: `split_outward` → `split` (**must**), arrows → `push` with direction,
      circle → `iris_round` (both optional, cut first).
   4. Flash picks the clip(s) via a new `transition` action, schema-validated like the others ("use this
      video afterwards" = the named/selected clip plays right after the current one).
   5. One proposal: `timeline.move` (only if needed) + the transition → preview → Accept/Reject → one undo.
   6. Clear the ink (`ui.set {ink: null}`) after Accept or Reject.
   - `unknown` → `answer` with the description; nothing changes.
4. **Known bug on this path:** `stage()` returns 502 when the engine refuses an edit; turn it into a
   friendly assistant reply.

## Tests (no camera, no window, no key needed)

`assistant.test.mjs` with the fake editor + fake proxy: figure mapping, unknown figure, stale revision,
oversized image refused, ink cleared after decision. Proxy test for `images`. Rust proposal test.

## Verify and hand back

- `cargo xtask ci` and `node --test surface/*.test.mjs surface/gestures/*.test.mjs surface/voice/*.test.mjs shway/*.test.mjs`.
- Live behaviour is **not verified** in the cloud; say so. The creator checks on the Mac:
  draw split figure → say/type "use this video afterwards" → preview → Accept → one undo restores it.
- Commits: task id **DEV-93**, one per green step, ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Push to a branch off
  `claude/part-two-handoff-1897cd` (e.g. `claude/track-c-sketch`) and report the branch; don't open a PR to
  `main` unless asked.
- Update [interactions](wiki/interactions.md) with the sketch vocabulary, each item marked verified or not.
