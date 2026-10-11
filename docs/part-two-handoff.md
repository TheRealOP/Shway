# Part 2 handoff: camera gestures, sketch-to-edit, live voice

Written 2026-10-11 ~03:20 EDT for a cloud Claude session. Branch: `claude/step-back-8836fb`.
That branch is `main` (13a74ba) plus the TRIBE-tabled wiki note (db1fbc2) plus the DEV-113 review page
merge (93d630c). All 90 Node tests pass on it.

**Time box:** the hackathon submission is Sunday morning (2026-10-11). Build until about **06:00 EDT**,
then freeze. The last three hours are DEV-98: rehearse, record and submit on the creator's Mac.
If a track overruns, cut scope (see "Order and cut line"); never leave the branch red.

## Read first

1. [AGENTS.md](../AGENTS.md) and [CLAUDE.md](../CLAUDE.md). Never crash, pure-Rust engine, every action
   is a command, quality gates, one task id per commit.
2. [Interactions](wiki/interactions.md): the gesture state model and its guards.
3. [surface/gestures/README.md](../surface/gestures/README.md): recognizer behaviour, events, bridge.
4. [surface/README.md](../surface/README.md) `review.html` section (DEV-113: camera/mic remote → assistant → editor).
5. [shway/README.md](../shway/README.md) assistant and Gemini proxy sections.

## Decisions already made (don't reopen)

- **TRIBE is tabled** for the hackathon ([decisions](wiki/decisions.md)). Don't touch TRIBE code or issues.
- **Part 2 drives the desktop editor** through `shway/assistant.mjs`. The browser page is only for the camera and mic.
- **Sketch reading** uses a **Gemini Pro-tier vision model** through the existing proxy (same key).
  Gemini 3.8 Flash stays the action picker. No new provider and no new key.
- **Voice** uses **Gemini Live**, hands-free, with **text replies** in the editor chat panel and a **mute**
  toggle. Push-to-talk (existing `/transcribe`) is the fallback.
- **Pause and slider scrub:** making a **fist pauses** playback. **Sliding the fist left/right** is a
  slider scrub: the playhead follows the hand like a dragged scrubber.
- **Shuttle (speed scrub):** the 🤘 pose (index and pinky out, middle and ring down, thumb ignored)
  **replaces the pinch** as the engage pose. The motion stays the existing **wrist twist**.
- Other Part 2 branches (cut DEV-114, insert DEV-115, music DEV-110, media DEV-117, paste DEV-116,
  learn DEV-95) are **parked**. They exist only on the creator's Mac. Don't recreate them.

## What to build

### Gesture grammar (one gesture, one meaning)

| Hand | Mode | Effect |
| --- | --- | --- |
| Index out, other fingers curled ("point") | Pointer | A dot follows the fingertip over the Program monitor picture |
| Thumb–middle **double tap** | Draw toggle | 1st: drawing on, so point = pen down and any other pose = pen up. 2nd: sketch finished; it stays on screen and is attached to the next spoken request |
| Fist | Pause | Stop playback as soon as the fist is held (~150 ms, so passing through a fist between poses doesn't count) |
| Fist slid left/right | Slider scrub | Playhead = playhead when the fist closed + gain × horizontal hand offset since then (absolute, no drift; dead zone). Open the hand to drop it there (stays paused) |
| 🤘 held | Shuttle | Engage (captures the neutral). Wrist twist = shuttle speed, Shift = fine steps, exactly as now |
| Esc | Cancel | Clear the ink, cancel any scrub and return to where the fist/🤘 started |

- Suppress swipe and chop while the hand is in the point pose, in a fist, or drawing is on. Fast
  pointer moves and fist slides must not fire them. Swipe now needs an open hand.
- While drawing is on, a fist only pauses and lifts the pen. It doesn't slider-scrub, because that would
  move the frame under the sketch.
- Double tap no longer toggles playback ("play"/"stop" are now spoken).
- `review.html` currently uses "a still pinch = stop + talk" and pinch-twist scrub. Move both onto the
  new grammar: voice is hands-free, so stop is spoken or the V key, and scrub is 🤘.

### Sketch vocabulary (one drawing, one edit)

The vision model only **classifies** the sketch into a fixed figure enum. **Code** maps figure → edit, so
the creator can learn the vocabulary and get the same result every time.

| Figure (enum) | Edit | Priority |
| --- | --- | --- |
| `split_outward`: vertical line + two arrows pointing apart | `split` video transition at the current clip's out edge | **Must (demo hero)** |
| `arrow_left` / `arrow_right` | `push` transition in that direction | Optional |
| `circle` | `iris_round` transition | Optional |
| `unknown` | Reply with what it saw and ask; nothing changes | Must |

Speech supplies the rest. "Use this video afterwards" means the clip the creator names (or the selected
one) plays right after the current clip. One proposal holds two steps, `timeline.move` (only if needed)
then the transition, so preview, Accept/Reject and a single undo work as for every other assistant edit.

Engine facts already checked:
- `sequence.applyVideoTransition` takes `{clip, effect, frames?, edge:"in"|"out", params?, reverse?}`
  (`crates/engine/src/commands.rs:1517`).
- `split`, `push` and `iris_round` exist (`crates/render/src/transitions/legacy.rs`).
- Proposal steps today are `timeline.trim | clip.replaceFromBin | timeline.place | timeline.remove | timeline.move`
  (`crates/engine/src/proposals.rs:40`).

## Plan

### Step 0: checks (≤15 min)

1. Merge `main` if it moved.
2. If `GEMINI_API_KEY` is set in this environment, list the models (`GET …/v1beta/models`) and record the
   exact Pro-tier vision model id and Live model id that this key can use. **Don't guess model ids.**
   Confirm the Live ephemeral-token flow (proxy mints the token, the browser connects with it) against
   Google's current docs. If there's no key here, build against the docs with injected-fetch tests (as
   `shway/gemini-server.test.mjs` does) and leave the ids as config with a clear error. The creator
   verifies live on the Mac.

### Track A: ink overlay in the editor (Rust, ~40 min)

- UI state (serde, agent-readable): `ink: {pointer: [x,y] | null, strokes: [[[x,y], …], …], drawing: bool}`.
  Coordinates are normalised 0–1 over the **frame picture**, not the panel.
- `ui.set {ink: {...}}` in `crates/ui-egui/src/control.rs` (next to the `program`/`source` merge at
  ~line 190). Treat it as hostile input: cap at 20 strokes × 500 points, drop non-finite or out-of-range
  points, never panic.
- Paint in `crates/ui-egui/src/panels/monitor.rs` beside the existing Program overlays
  (`graphics::monitor_overlay` / `masks::monitor_overlay`, ~line 287): a dot when idle, a ring when
  drawing, strokes in a high-contrast colour. Program monitor only.
- `ui.screenshot {panel:"program"}` must then capture the frame **with** the ink. That's the image the
  vision model gets.
- Tests: hostile `ui.set` payloads; overlay state round-trip. Add an egui_kittest snapshot only if cheap.
- Update `docs/control-protocol.md` (`ui.set` row).

### Track B: recognizer poses and events (JS, ~40 min)

All of this is in `surface/gestures/recognizer.mjs`, which is pure and deterministic. Keep its
hostile-input rules.

- **Finger extended:** the tip is farther from the wrist than its knuckle (`FINGERS` already lists
  `[knuckle, tip]`).
- **Point pose:** index extended; middle, ring and pinky curled.
- **🤘 pose:** index and pinky extended, middle and ring curled; the thumb is ignored. (Originally the
  thumb also had to touch the middle and ring tips; dropped because live the pose didn't register.)
- **Fist pose:** all four fingers curled (tip nearer the wrist than its knuckle), held ≥ ~150 ms.
- **Events:**
  - `pointer {x, y}`: index tip mapped from the central ~60% of the camera image onto 0–1, mirrored,
    EMA-smoothed. Emit only on change.
  - `draw-toggle`, from the existing thumb–middle double-tap detector.
  - `pen-down`, `pen-up`.
  - Scrub engage moves from the pinch to the 🤘 pose. Twist, fine and loss behaviour are unchanged.
  - `pause` when a fist forms.
  - `slide {seconds}`: signed offset from where the fist closed, computed from palm x (wrist /
    middle-knuckle midpoint, mirrored). Use a `slideGain` in `DEFAULTS`, e.g. 20 s across the active box,
    plus a small dead zone. Emit only on change.
  - `release` when the fist opens. Tracking loss latches like the 🤘 scrub.
- **Bridge** (`surface/gestures/bridge.mjs`) and the assistant's `TRANSPORT` allowlist
  (`shway/assistant.mjs`, from DEV-113):
  - `pause` → `stop()`, and remember `playhead()` for cancel.
  - `slide` → `seekTicks(remembered + seconds)`, latest-wins and clamped at 0. It creates no undo
    entries.
  - `double-tap` no longer calls `togglePlay`.
- **Tests:** `recognizer.test.mjs` replay tests for:
  - the point pose, 🤘 engage, and "pinch no longer engages"
  - draw-toggle and pen up/down
  - fist → pause, fist slide → slide offsets, and "a brief fist between poses doesn't pause"
  - "no swipe while pointing or in a fist", and "no slide while drawing"

  Add bridge tests for `pause`/`slide`. Keep every existing guard test green, or change it deliberately.
- **Camera page:** `review.html`/`review.mjs` builds the stroke list from these events and POSTs
  `{pointer, strokes, drawing}` to the assistant at ≤30 Hz, latest-wins, dropping stale updates. Update
  `surface/gestures/README.md`.

### Track C: sketch → edit (Node + small Rust, ~45 min)

- **Rust:** add a `sequence.applyVideoTransition` step to `proposals.rs` (`{clip, effect, edge}` only;
  allowlist `split | push | iris_round`). It runs in the disposable candidate session like the other
  steps. Add one test with the existing proposal tests, including a refused effect.
  *Fallback if this slips:* apply directly and make Reject run `edit.undo` after checking the revision.
- **Proxy** (`shway/gemini-server.mjs`): `/generate` accepts an optional
  `images: [{mimeType: "image/png"|"image/jpeg", data: base64}]`. Cap the count and bytes, and raise
  `MAX_BODY` (currently 2 MB) only as far as one Program screenshot needs. Test it.
- **Assistant** (`shway/assistant.mjs`):
  - `POST /ink` → `ui.set {ink}`. Like `/review/transport`, it skips the busy lock and coalesces to the
    latest.
  - `POST /chat {message, sketch?: true}` with a sketch:
    1. `ui.screenshot {panel:"program"}`.
    2. Vision model via `/generate` with the image + normalised strokes, schema
       `{figure: enum, direction?, description}`.
    3. Code maps the figure using the table above.
    4. Flash picks the clip(s) through a new `transition` action, schema-validated like the others.
    5. One proposal (`timeline.move?` + transition) → preview.
    6. Clear the ink after a decision.
  - Unknown figure → `answer` with the description; nothing changes.
- **Tests** in `assistant.test.mjs` with a fake editor and fake proxy: figure mapping, unknown figure,
  stale revision, oversized image refused.

### Track D: Gemini Live voice (JS, ~45 min, last)

- **Proxy:** `POST /live-token` mints a short-lived, single-use Live token. The API key never reaches the
  browser. Only localhost origins can call it (reuse `allowedOrigin`).
- **Camera page:**
  1. Open the Live session with the token: text response modality, input-audio transcription, built-in
     voice activity detection.
  2. Stream the mic as 16 kHz PCM.
  3. On each finished user turn, POST its transcript to `/chat`, with `sketch: true` if a finished
     sketch is waiting.
  4. Assistant replies already appear in the editor chat panel (it polls `GET /chat/state`).
- **Mute:** a button and the **M** key. Show listening/muted state clearly. Muted means no audio is
  sent at all.
- **Fallback:** if Live isn't working by the time box, ship push-to-talk (`/transcribe`) and say so.

## Order and cut line

Step 0 → A → B → C → D. At about 06:00 EDT, freeze. Cut D first (push-to-talk covers the demo line),
then the optional push/iris figures. **Never cut `split_outward`.**

## Verify

- **Here (cloud):** `cargo xtask ci` (fmt, clippy `-D warnings`, tests, layers, assets, wasm), plus
  `node --test surface/*.test.mjs surface/gestures/*.test.mjs surface/voice/*.test.mjs shway/*.test.mjs`.
  No camera, mic or macOS window here, so report live behaviour as **not verified**.
- **On the creator's Mac (after the push).** Run each in its own terminal:

  ```bash
  cargo run --release -p filmcraft -- --control 9876 <project>.fcproj
  node shway/gemini-server.mjs --port 8790
  node shway/assistant.mjs --port 8793 --editor 127.0.0.1:9876 --proxy http://127.0.0.1:8790
  python3 -m http.server -d surface 8771 --bind 127.0.0.1
  ```

  Then open `http://127.0.0.1:8771/review.html` in Chrome, in a corner the editor window doesn't cover.
  Demo path: point → dot moves; double tap → draw line + two arrows → double tap; say "use this video
  afterwards" → preview shows the split into the next clip → Accept → one undo restores it.
  Fist pauses; fist slid sideways scrubs; 🤘 + twist shuttles. M mutes.

## Risks

- **Camera page throttling:** browsers pause camera processing in hidden or fully covered windows, and
  `ui.screenshot` brings the editor forward. Keep the camera window visible beside it.
- **Audio bleed:** Gemini Live also hears the editor's playback. Use headphones for the demo, or mute
  while playing.
- **Thumb–middle double tap while pointing** is only replay-tested. Keep its thresholds in `DEFAULTS` so
  they can be tuned on camera.
- **Known bug:** `stage()` returns 502 when the engine refuses an edit ("edit failed"). Turn that into a
  friendly reply if you touch it.

## Conventions

- Commits: one task id each. Suggested ids: Track A/B **DEV-91** (hand interactions), C **DEV-93**
  (creative revision), D **DEV-113** (voice review). End messages with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Commit after every green step. Push to `claude/step-back-8836fb` (or a branch off it) and open a PR to
  `main` with honest planned-versus-verified status.
- Update [interactions](wiki/interactions.md) with the new grammar and sketch vocabulary, with each item
  marked verified or not.
