# Gesture recognition (DEV-91 slice)

Camera hand landmarks + keys in, navigation events out. No editor calls.
Contract: [interactions](../../docs/wiki/interactions.md).

| File | What |
| --- | --- |
| `recognizer.mjs` | Pure, deterministic recognizer (`createRecognizer`, `replay`). Runs in Node and browsers, no build step. |
| `recognizer.test.mjs` | Replay tests: `node --test surface/gestures/*.test.mjs` (Node ≥ 22, no packages). |
| `camera.html` | Camera harness: MediaPipe Hand Landmarker → recognizer → hand overlay (skeleton, 🤘 meter, twist dial with dead zone/speed bands/fine detents, tap dot, chop-ready blade line, gesture flash), pose/drawing readout, latency, trace recorder (R). |
| `hands.mjs` | Browser-only camera open, MediaPipe loop and overlay drawing, shared by `camera.html` and `../demo.html`. |
| `bridge.mjs` | Gesture events → `shway/adapter.ts` calls (serialized, latest-wins shuttle). Tests: `bridge.test.mjs`. |
| `traces/*.json` | Recorded traces (none yet). Every file is replayed by the tests; names starting `rest` must emit nothing. |

The directory sits outside `apps/` because `apps/*` is a Cargo workspace glob.

## Behaviour

States: `Idle → Armed ⇄ Adjusting → Idle`, `Idle → Fist → Idle`, plus latched `TrackingLost` / `Cancelled`.
The FST's `Targeting / Preview / Committed` belong to edit proposals (DEV-92), not scrubbing.
All thresholds are in `DEFAULTS` so they can be tuned on camera.

### Part 2 grammar (one gesture, one meaning)

| Hand | Events | Status |
| --- | --- | --- |
| **Finger extended / curled** | tip farther from the wrist than its knuckle (`fingerOut` 1.0) = extended, else curled | Verified (replay tests) |
| **Point** (index out, middle/ring/pinky curled) | `pointer {x, y}`: index tip, central 60% of the image (`pointerBox`) → 0–1, mirrored so the user's right is +x, EMA `pointerSmoothing` 0.5, emitted when it moves ≥ `pointerMinMove` 0.003. Default mode = laser pointer | Verified (replay) |
| **Thumb–index double tap** | `draw-toggle {drawing}`. Two taps, each closed ≤ `tapMaxMs` 350, the second starting ≤ `doubleTapGapMs` 400 after the first ends. Closed = tip distance / palm < `tapOn` 0.35 (open > `tapOff` 0.5), nearer of 3D and on-screen, thumb `tapMiddleRatio` 1.2× nearer the index tip than the middle tip, never from a fist. A held pinch does nothing | Verified (replay) |
| **Drawing on, point** | `pen-down`, then `pointer` while it moves; any other pose → `pen-up`. While the thumb is on the index tip the pointer freezes and the pen lifts, and after a single tap the pen stays up for `doubleTapGapMs`, so the "drawing off" double tap leaves no stroke | Verified (replay) |
| **Fist** (all four curled) held ≥ `fistHoldMs` 150 | `pause`; open the hand → `release` (stays paused). A fist passed through between poses does nothing | Verified (replay) |
| **Fist slid left/right** | `slide {seconds}`: palm x (wrist / middle-knuckle midpoint) offset from where the fist closed, mirrored, EMA-smoothed, dead zone `slideDeadZone` 0.03 of the box, `slideGain` 20 s per box width, quantized to `slideStep` 0.05 s, emitted on change. Absolute, so no drift | Verified (replay) |
| **Fist while drawing** | `pen-up` + `pause` only: no slide (and no 🤘 engage) while drawing, so the frame doesn't move under the sketch | Verified (replay) |
| **🤘 held** (index + pinky out, middle + ring curled, thumb on both their tips) | `engage`; twist / Shift / loss exactly as before. Ratio = farther of thumb–middle and thumb–ring tip distance / palm, engage < `hornsOn` 0.35, release > `hornsOff` 0.5 | Verified (replay) |
| **Esc** | `cancel`: in a fist or 🤘 it latches and the bridge returns to where it started; while drawing it drops the sketch | Verified (replay) |

Not verified: any of it with a live camera (thresholds, mirroring, the thumb–index double tap while
pointing, fist detection with real curled fingers). Swipe and chop now need an open hand (all four
extended): pointing, fists and drawing never fire them.

### Shuttle and the older gestures

- **Engage:** the 🤘 pose above (it replaced the thumb–index pinch, which is now the draw tap), or hold Space.
  Engagement captures the neutral knuckle direction.
- **Twist:** roll about the wrist→middle-knuckle axis, measured against the captured neutral each frame
  (absolute, not integrated, so no drift). EMA-smoothed, 12° dead zone, quantized to
  ±0.5/1/2/4× by 60°. Left-hand angles are negated so the mirrored motion gives the same sign.
- **Fine mode (Shift):** no shuttle; one `step` frame per 8° detent beyond the dead zone. Back to neutral
  gives a net 0. Toggling modes stops the shuttle and never jumps.
- **Swipe:** only in `Idle`, open hand, not drawing. Palm travel ≥ 18% of image width within 250 ms, mostly horizontal.
  700 ms cooldown, plus 400 ms quiet after any release. Slow drift and diagonal motion don't count.
- **Double tap:** see the grammar table (thumb–index, `draw-toggle`). The nearer of the 3D and on-screen
  measures is used because a turned hand hides the tips and makes the 3D depth noisy, but touching tips
  stay close on screen. A hold or a tracking gap resets it.
- **Chop:** only in `Idle`. The hand must be in blade pose (four fingers straight, edge-on to the camera)
  when the motion starts. Then the index/middle fingertips must drop ≥ 0.7 on-screen palm lengths
  within 250 ms. Fingertips are tracked, not the palm, because a wrist flick barely moves the palm.
  Diagonal arcs are allowed (|dx| ≤ 2.5 dy). A dropped frame from motion blur doesn't reset the window.
  1 s cooldown, which also blocks swipes. Palm-facing drops, curled hands, slow or upward moves, and
  sideways blade swipes don't cut.
- **Loss:** no hand, confidence < 0.6, malformed/non-finite landmarks, or a handedness flip while
  engaged → `shuttle 0` + `tracking-lost` (in a fist: `tracking-lost`; the fist must open before it can pause again). The same for Esc → `cancel`. Control stays latched until
  engagement is released, then needs a fresh engage (new neutral).
- Hostile input (non-finite/backwards time, garbage frames) is ignored and never throws.

## Driving the editor (`bridge.mjs`)

`createBridge(adapter)` maps events onto the typed gesture methods in `shway/adapter.ts`. Calls run
one at a time, in order. Queued shuttle updates collapse to the latest rate. A failed call is reported
and the queue carries on.

| Event | Adapter call (engine) |
| --- | --- |
| `engage` | `playhead()` (`ui.inspect`), remembered for cancel |
| `shuttle {rate}` | `shuttle(rate)` (`ui.playback play, speed`), or `stop()` for 0 |
| `step {frames}` | `stepFrames` (`playhead.step`) |
| `pause` | `stop()` then `playhead()`, remembered for slide and cancel |
| `slide {seconds}` | `seekTicks(paused playhead + seconds)`, clamped at 0, latest wins (`playhead.set`: no undo entry) |
| `cancel` | `seekTicks(engage / pause playhead)` (`playhead.set {time}`) |
| `swipe` | `nextEdit` / `prevEdit` (`playhead.nextEdit` / `prevEdit`) |
| `chop` | `cut()` (`sequence.addEdit`: one undo step) |
| `draw-toggle`, `pen-down`, `pen-up`, `pointer` | none: ink, handled by the camera page (`review.mjs` `createInk` → assistant `POST /ink` → `ui.set {ink}`). Double tap no longer toggles playback |

Run it against the real editor with the demo page: `node surface/build-demo.mjs <editor dist> --out target/demo`,
serve it, and open `demo.html` (see [surface](../README.md)). `camera.html?editor` still works when
`camera.html`, `recognizer.mjs`, `hands.mjs` and `bridge.mjs` sit flat beside the editor's `index.html` and `adapter.js`.

**Verified 2026-10-10** (browser pane, PR #2 engine build, demo project, synthetic events, no camera):
- Shuttle 2×: the playhead moved 3.0 s in 1.5 s. Stop works.
- Fine steps: +3 frames, then −1.
- Cancel returned the playhead to its engage position.
- Swipes moved to the next and previous edit points.
- Chop cut V1, A1 and A2 at the playhead, and one undo ("Add Edit") restored it.
- Double tap toggled playback.

**Limits seen:**
- Reverse shuttle (−1×) ran at about 0.5× real time.
- Playback only advances while the tab is visible.
- Camera-driven end-to-end latency is unmeasured.

## Integration boundary (for the editor adapter)

```js
import { createRecognizer } from "./recognizer.mjs";
const r = createRecognizer(/* optional overrides of DEFAULTS */);
for (const e of r.step(frame)) adapter(e);   // frame: {t, hand, key, fine, cancel}
r.view();  // {state, rate, fine, angleDeg, handedness, confidence, horns, hornsRatio, tapping, blade, tapRatio, chopTravel, pose, drawing, penDown, pointer} for on-screen feedback
```

`camera.html` exposes `window.shwayGestures.setSink(fn)` to replace its log sink.

| Event | Meaning | Candidate editor call (verify in DEV-87) |
| --- | --- | --- |
| `engage` | Control armed; remember playhead for cancel | read playhead (`ui.playback` result / `ui.inspect`) |
| `shuttle {rate}` | Signed realtime multiple; `0` = pause. Only emitted on change | `ui.playback {action:"play", speed: rate}` / `{action:"stop"}` |
| `step {frames}` | Fine-mode frame delta (signed) | `playhead.step {frames}` |
| `release` | Done; keep the position | none (stop already sent) |
| `cancel` | Restore the engage-time playhead | `playhead.set {time}` |
| `tracking-lost` | Paused; show it; wait for re-engagement | none (stop already sent) |
| `pointer {x, y}` | Laser dot, 0–1 over the frame | ink (`ui.set {ink}`) |
| `draw-toggle {drawing}` | Thumb–index double tap | ink: drawing on / sketch finished |
| `pen-down` / `pen-up` | Start / end a stroke while drawing | ink |
| `pause` | Fist held | `ui.playback {action:"stop"}`, read playhead |
| `slide {seconds}` | Fist offset since it closed | `playhead.set {time}` |
| `chop` | Cut at the playhead (an edit: one undo step) | `sequence.addEdit` (Cmd+K; `time` defaults to the playhead) |
| `swipe {direction}` | One contextual navigation (user's left/right) | e.g. `playhead.nextEdit` / `prevEdit`, or next/previous take (context is the adapter's) |

Those method and command names exist in `crates/ui-egui/src/control.rs` and `crates/engine/src/commands.rs`.
`app.play(speed)` only special-cases `speed > 0`. Nobody has run reverse speeds, mapped steps or
swipe contexts against the editor yet. Scrubbing moves the playhead and creates no undo entries; that
is the adapter's to confirm.

## Part 2 status (2026-10-11)

- **Verified (tests):** 37 recognizer replay tests, 9 bridge tests, 8 review tests and the assistant's
  `/ink` + pause/slide tests pass (107 Node tests in all, Node 26.4).
- **Verified (browser pane, synthetic events, fake editor):** `review.html` loads; 22 ink events reached the
  editor as 2 coalesced `ui.set {ink}` calls.
- **Not verified:** live camera for every pose; the real editor painting the ink (Track A).

## Handoff: status and evidence (2026-10-10)

- **Verified:** 28 recognizer replay tests + 7 bridge tests pass (Node 26.4). They were mutation-checked: removing the
  re-engage latch, cooldown, handedness mirror, dead zone, rate bound, fine-switch guard,
  handedness-flip check, post-release quiet, or backwards-time guard each fails ≥1 test.
- **Verified:** `camera.html` loads and reports camera permission denial in Claude's browser pane.
  There, MediaPipe Tasks Vision 0.10.14 + the float16 hand model loaded in about 7.7 s.
  `detectForVideo` on a blank 640×480 frame took 8.8 ms p50 / 10.0 ms p95. That frame has no hand,
  so this is not a gesture latency result.
- **Not verified (blocked):** live camera tracking. The browser pane blocks camera access, so open
  `camera.html` in a normal browser on the Mac. Still unmeasured: real twist sign (set
  `invert` if forward feels backward), thresholds, handedness labels from an unmirrored feed,
  occlusion behaviour, and end-to-end p95 feedback latency (shown on the page; goal < 150 ms).
- **Synthetic traces only.** Record real ones with R: a resting set (`rest-*.json`), twist, swipe and
  occlusion sets. Drop them in `traces/` so they run in the tests.
- **Open for DEV-91 acceptance:** editor integration (Codex/DEV-87 adapter), visible target/mode
  inside the editor UI, and measured latency. Keep DEV-91 open until those are demonstrated.

## Related

[Interactions](../../docs/wiki/interactions.md) · [Acceptance](../../docs/wiki/acceptance.md) · [Architecture](../../docs/wiki/architecture.md)
