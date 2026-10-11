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
| 🤘 held (index + pinky up, middle + ring down, thumb ignored) | Shuttle | Engage; wrist twist = speed, Shift = frame steps, unchanged | Verified in replay tests; live not verified |
| Esc | Cancel | Clears the sketch; a scrub returns to where the fist / 🤘 started | Verified in replay and bridge tests |

Guards: swipe and chop need an open hand, so pointing, fists and drawing never fire them. While
drawing, a fist only pauses and lifts the pen, and 🤘 doesn't engage, so the frame stays under the
sketch. Double tap no longer toggles playback; play/stop are spoken or keys. The thumb–index pinch
(the old scrub engage) is now only the draw tap. Ink reaches the editor through the assistant's
`POST /ink` → `ui.set {ink}`, at most 30 Hz, latest wins.

The thumb–index tap replaced the handoff's thumb–middle tap at the creator's request (2026-10-11).

## Freehand drawing + explanation (2026-10-11)

One finished sketch and its typed or transcribed explanation form one multimodal request.
The assistant sends the Program monitor PNG, ordered strokes in full-picture normalized coordinates,
current clip/selection, playhead and project context to the existing vision model
(`gemini-3.1-pro-preview`). There is no recognized-shape enum: a circle can identify a region
and arrows can describe framing or motion. The explanation determines the intended edit;
a circle does not automatically request an iris transition.

Supported outputs stay bounded: existing trim/remove/move/take replacement, a split/push/iris
transition, a static zoom into an explicit normalized rectangle, or a batch from the runtime
`proposal.tools` catalog. Unsupported or ambiguous requests ask for clarification and retain the
sketch. Registry descriptions do not authorize arbitrary execution.

For example, draw a circle around a subject with outward arrows and explain “Zoom 2x into the
circled area.” The assistant proposes a relative 2× zoom/recenter on the video clip under the
captured frame. `clip.zoomRegion {clip, region:[left,top,right,bottom], factor}` is a proposal
step that composes the existing Motion position/scale through `effects.setParam`.
It applies to the whole clip, preserves rotation/anchor/nonuniform proportions and linked audio,
and refuses animated or disabled Motion. Region coordinates must be finite 0–1, at least 0.02
wide/high; factor must be >1 and ≤4; composed scales are capped at 4000%.

The first nonempty ink pauses playback and binds the drawing to revision, sequence, playhead
and topmost video clip. A changed frame/project before interpretation, or changed drawing/frame/project
during interpretation, refuses staging. The screenshot is sent only when `perf.stats` reports
the Program picture at the captured frame and project revision, checked before and after capture. Preview, explicit Accept/Reject, and one-step Undo use
the existing engine path. Decisions consume only the submitted strokes, preserving newer ink.

See [acceptance evidence](acceptance.md#freehand-intent-and-region-zoom-2026-10-11) for checks
and limitations; live camera/model interpretation and export of this zoom are separate checks.

### Ordinary tools and transition inspection

`edit.steps` names approved commands, explicit timeline clip IDs and target-free arguments.
Rust validates the catalog, argument types/ranges, effects, locked targets and linked partners,
and runs the whole batch in the disposable proposal session. Accept commits one history entry;
Reject discards it. Effects/keyframes, speed/reverse, audio gain/volume, split/slip/slide/roll,
nudges, framing, text/shapes, captions and essential-sound tagging reuse existing commands.
Select/seek/step/next/previous are separate bounded navigation actions.

The current catalog has 62 generic commands and 180 applicable video/audio effects. Within the
core `clip.*`, `timeline.*`, `effects.*` namespaces it supports 57 of 89 project-editing command
entries (64%, **including shortcut aliases**). All 121 journaled core entries remain reported;
32 exclusions are selection/targeting state, preferences, reveal and external audio extraction,
listed by ID in the catalog. Specialized project edits such as multicam, remix and source metadata
remain in the denominator even though unsupported. This is command-entry coverage, not a claim
about a majority of every editor capability. Files, export, recording and preferences require
their own flows; curve/path parameters require another bounded schema.

A proposed transition is rendered through its staged token at five ordered times around the
cut, clamped to valid sequence frames and deduplicated (at least three frames required).
Up to 128-pixel frames and exact timestamps go together
to vision for inspection. A failed/invalid review, rendering failure or stale token cancels the
candidate. Only inspected candidates become pending for Accept. `/chat/preview` serves the same
token's images to the review page, labeled **timed sampled frames**, not continuous playback.
Sparse frames cannot verify motion between samples or audio; the creator retains Accept/Reject.

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
