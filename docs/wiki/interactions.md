# Interactions

## Live path

Camera → hand landmarks → confidence and smoothing → deterministic controller/state transitions
→ validated preview commands → visual feedback.

Keep LLM and TRIBE calls off this path. Use a worker for camera recognition where appropriate.
A gesture must visibly identify its mode, target, and effect.

## Initial mappings

| Input | Meaning | Guard |
| --- | --- | --- |
| 🤘 pose (was pinch) or explicit screen/key engagement | Arm the selected control | Target and armed indicator visible |
| Relative hand twist while engaged | Signed scrub/shuttle speed | Neutral dead zone, limits; release stops |
| Deliberate left/right swipe | Navigate clips or alternative takes | Context label, temporal threshold, cooldown |
| Reject gesture + spoken correction | Propose take replacement | Visible current take and reversible preview |
| Vertical movement with a bound parameter | Adjust exposure or gain | Explicit parameter binding and limits |

Reject and split-at-playhead are separate commands. An upward motion does not silently mean “more tension.”

## Part 2 gesture grammar (2026-10-11)

One gesture, one meaning. Thresholds live in `DEFAULTS` in
[surface/gestures/recognizer.mjs](../../surface/gestures/recognizer.mjs); details and events in the
[gestures README](../../surface/gestures/README.md).

| Hand | Mode | Effect | Status |
| --- | --- | --- | --- |
| Index out, other fingers curled ("point") | Laser pointer (default) | A dot follows the fingertip over the Program monitor picture | Verified in replay tests; live camera not verified |
| Quick thumb–index **double tap** | Draw toggle | 1st: drawing on, point = pen down, any other pose = pen up. 2nd: sketch finished, stays on screen, back to laser pointer. A held pinch does nothing; the tap freezes the pointer and lifts the pen | Verified in replay tests; live camera not verified |
| Fist held ~150 ms | Pause | Stops playback. Passing through a fist doesn't count | Verified in replay and bridge tests; live not verified |
| Fist slid left/right | Slider scrub | Playhead = playhead at the pause + 20 s × offset across the active box (absolute, dead zone). Open the hand to drop it there | Verified in replay, bridge and assistant tests; live not verified |
| 🤘 held | Shuttle | Engage; wrist twist = speed, Shift = frame steps, unchanged | Verified in replay tests; live not verified |
| Esc | Cancel | Clears the sketch; a scrub returns to where the fist / 🤘 started | Verified in replay and bridge tests |

**Camera path (2026-10-11):** the webcam runs natively, not in a browser:
`node shway/assistant.mjs … --camera` starts `shway/hands.py` (MediaPipe Hand Landmarker via `uv run`) and
handles the recognizer's events in-process; the editor shows a small camera tile outside the Program monitor.
Verified: fake-stream tests (frames → recognizer → ink and pause on a fake editor), the tile's
hostile-input tests, and the worker's no-camera error on the creator's Mac. Not verified: live hand tracking
through it (camera permission was not granted during the check) and latency (CPU landmarker ≈ 59 ms per
frame on a blank frame). Keys (Space, Shift, Esc) don't reach the recognizer on this path, and push-to-talk
voice is unavailable until it moves into the native path.

Guards: swipe and chop need an open hand, so pointing, fists and drawing never fire them. While
drawing, a fist only pauses and lifts the pen, and 🤘 doesn't engage, so the frame stays under the
sketch. Double tap no longer toggles playback; play/stop are spoken or keys. The thumb–index pinch
(the old scrub engage) is now only the draw tap. Ink reaches the editor as the assistant's
`ui.set {ink}`, latest wins.

The thumb–index tap replaced the handoff's thumb–middle tap at the creator's request (2026-10-11).

## State model

Idle → Targeting → Armed → Adjusting → Preview → Committed. The recognizer adds a Fist state (paused, sliding).
Cancelled and TrackingLost restore or preserve the pre-action state and require re-engagement.

The finite-state transducer handles discrete events and action boundaries.
A separate continuous controller turns numeric trajectories into scrub speed or parameter values.
Neither is an arbitrary gesture-understanding model.

## Twist and swipe

Capture neutral orientation at engagement. Measure relative rotation about the forearm axis;
use a dead zone and bounded signed speed. Fine mode can reduce gain and step frames.
Avoid integrating frame-to-frame rotation indefinitely, which drifts.

Estimate orientation from multiple landmarks and test handedness, occlusion, and comfortable range.
Low confidence pauses control. During twist adjustment, suppress swipe navigation.

## Voice fusion

Start with push-to-talk and visible recording feedback.
Playback audio must not become a command. Associate speech, current selection, and gestures within
a bounded observation window. Resolve “this” to a visible target; ambiguous targets need selection.

Preserve precise keyboard, mouse, timeline, and frame controls. Cancel is always reachable.
One continuous adjustment commits once and undoes once.

## Evidence

Measure p95 gesture-to-visible-feedback latency, aiming below 150 ms on demo hardware.
Measure actual latency rather than advertising the target as a result.

**Status 2026-10-10:** recognition slice (engage, twist shuttle/fine step, swipe, loss/cancel latch)
is implemented in [surface/gestures](../../surface/gestures/README.md). It passes synthetic replay tests.
Live camera tracking, editor integration and latency are not yet verified.
The README holds the event boundary for the adapter.

**Voice status 2026-10-10:** push-to-talk capture is implemented in
[surface/voice](../../surface/voice/README.md). Utterances snapshot the interaction context at start
and carry gestures from a bounded window (2 s before start through release). Capture exists only
while push-to-talk is held. Replay tests pass and are mutation-checked. The harness reports
microphone denial. Live microphone capture, speaker bleed and speech-to-text (no provider chosen)
are not verified. Target resolution and proposal creation remain DEV-92 work.

**Take replacement status 2026-10-10 (DEV-92):** [shway/replace.ts](../../shway/README.md#take-replacement-dev-92)
turns a transcript and its context snapshot into a previewed replacement. The target is the
captured selection: one clip or its linked A/V pair. With no clip or several clips selected it
asks for a selection and does not call the model. Gemini chooses only among the indexed takes of
the same statement, which it sees as opaque numbers. Rust stages the edit. Accept, reject and undo
each take one step. Speech-to-text runs through the local proxy's `POST /transcribe`.

- **Verified:** tests pass and are mutation-checked.
- **Verified:** one live transcription returned the exact spoken sentence.
- **Verified:** a live model choice picked the laughing take.
- **Verified:** in the real browser engine with generated fixtures:
  - The flow ran from preview through commit, a single undo, cancel and a stale rejection.
  - The preview rendered the chosen take's frames.
  - The replacement worked within one source item and from another source item.
- **Not verified:**
  - A live microphone recording.
  - The demo page as a whole.
  - Replacement items that have source In marks.

## Related pages

[Wiki map](README.md) · [Architecture](architecture.md) · [Adaptation](adaptation.md) · [Acceptance](acceptance.md)
