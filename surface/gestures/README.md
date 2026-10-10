# Gesture recognition (DEV-91 slice)

Camera hand landmarks + keys in, navigation events out. No editor calls.
Contract: [interactions](../../docs/wiki/interactions.md).

| File | What |
| --- | --- |
| `recognizer.mjs` | Pure, deterministic recognizer (`createRecognizer`, `replay`). Runs in Node and browsers, no build step. |
| `recognizer.test.mjs` | Replay tests: `node --test surface/gestures/*.test.mjs` (Node ≥ 22, no packages). |
| `camera.html` | Camera harness: MediaPipe Hand Landmarker → recognizer → hand overlay (skeleton, pinch meter, twist dial with dead zone/speed bands/fine detents, tap dot, chop-ready blade line, gesture flash), latency, trace recorder (R). |
| `bridge.mjs` | Gesture events → `shway/adapter.ts` calls (serialized, latest-wins shuttle). Tests: `bridge.test.mjs`. |
| `traces/*.json` | Recorded traces (none yet). Every file is replayed by the tests; names starting `rest` must emit nothing. |

The directory sits outside `apps/` because `apps/*` is a Cargo workspace glob.

## Behaviour

States: `Idle → Armed ⇄ Adjusting → Idle`, plus latched `TrackingLost` / `Cancelled`.
The FST's `Targeting / Preview / Committed` belong to edit proposals (DEV-92), not scrubbing.

- **Engage:** thumb–index pinch (tip distance / palm length < 0.35, release > 0.5; the thumb must also be 1.5× closer to the index tip than the middle tip, so thumb–middle pinches and fists don't engage), or hold Space.
  Engagement captures the neutral knuckle direction.
- **Twist:** roll about the wrist→middle-knuckle axis, measured against the captured neutral each frame
  (absolute, not integrated, so no drift). EMA-smoothed, 12° dead zone, quantized to
  ±0.5/1/2/4× by 60°. Left-hand angles are negated so the mirrored motion gives the same sign.
- **Fine mode (Shift):** no shuttle; one `step` frame per 8° detent beyond the dead zone. Back to neutral
  gives a net 0. Toggling modes stops the shuttle and never jumps.
- **Swipe:** only in `Idle`, unpinched. Palm travel ≥ 18% of image width within 250 ms, mostly horizontal.
  700 ms cooldown, plus 400 ms quiet after any release. Slow drift and diagonal motion don't count.
- **Double tap:** only in `Idle`. Two thumb–middle taps, each ≤ 350 ms closed, the second starting
  ≤ 400 ms after the first ends. "Closed" means tip distance / palm length < 0.35 (reopen > 0.5), using
  the nearer of the 3D and on-screen measures. A turned hand hides the tips and makes the 3D depth
  noisy, but touching tips stay close on screen. The thumb must also be 1.2× nearer the middle tip than
  the index tip. A hold or a tracking gap resets it.
- **Chop:** only in `Idle`. The hand must be in blade pose (four fingers straight, edge-on to the camera)
  when the motion starts. Then the index/middle fingertips must drop ≥ 0.7 on-screen palm lengths
  within 250 ms. Fingertips are tracked, not the palm, because a wrist flick barely moves the palm.
  Diagonal arcs are allowed (|dx| ≤ 2.5 dy). A dropped frame from motion blur doesn't reset the window.
  1 s cooldown, which also blocks swipes. Palm-facing drops, curled hands, slow or upward moves, and
  sideways blade swipes don't cut.
- **Loss:** no hand, confidence < 0.6, malformed/non-finite landmarks, or a handedness flip while
  engaged → `shuttle 0` + `tracking-lost`. The same for Esc → `cancel`. Control stays latched until
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
| `cancel` | `seekTicks(engage playhead)` (`playhead.set {time}`) |
| `swipe` | `nextEdit` / `prevEdit` (`playhead.nextEdit` / `prevEdit`) |
| `chop` | `cut()` (`sequence.addEdit`: one undo step) |
| `double-tap` | `togglePlay()` (`ui.playback toggle`) |

Run it against the real editor: build the web app (`cargo xtask web`, see [web](../../docs/web.md)), then
`node shway/build.mjs --out <dist>`, copy `recognizer.mjs`, `bridge.mjs` and `camera.html` into `<dist>`,
serve it, and open `camera.html?editor`. The editor loads in a same-origin iframe; the camera panel
floats in the corner.

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
r.view();  // {state, rate, fine, angleDeg, handedness, confidence, pinching, pinchRatio, tapping, blade, middleRatio, chopTravel} for on-screen feedback
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
| `double-tap` | Thumb–middle double tap | Suggested: play/pause, `ui.playback {action:"toggle"}` |
| `chop` | Cut at the playhead (an edit: one undo step) | `sequence.addEdit` (Cmd+K; `time` defaults to the playhead) |
| `swipe {direction}` | One contextual navigation (user's left/right) | e.g. `playhead.nextEdit` / `prevEdit`, or next/previous take (context is the adapter's) |

Those method and command names exist in `crates/ui-egui/src/control.rs` and `crates/engine/src/commands.rs`.
`app.play(speed)` only special-cases `speed > 0`. Nobody has run reverse speeds, mapped steps or
swipe contexts against the editor yet. Scrubbing moves the playhead and creates no undo entries; that
is the adapter's to confirm.

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
