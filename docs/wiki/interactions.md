# Interactions

## Live path

Camera → hand landmarks → confidence and smoothing → deterministic controller/state transitions
→ validated preview commands → visual feedback.

Keep LLM and TRIBE calls off this path. Use a worker for camera recognition where appropriate.
A gesture must visibly identify its mode, target, and effect.

## Initial mappings

| Input | Meaning | Guard |
| --- | --- | --- |
| Pinch or explicit screen/key engagement | Arm the selected control | Target and armed indicator visible |
| Relative hand twist while engaged | Signed scrub/shuttle speed | Neutral dead zone, limits; release stops |
| Deliberate left/right swipe | Navigate clips or alternative takes | Context label, temporal threshold, cooldown |
| Reject gesture + spoken correction | Propose take replacement | Visible current take and reversible preview |
| Vertical movement with a bound parameter | Adjust exposure or gain | Explicit parameter binding and limits |

Reject and split-at-playhead are separate commands. An upward motion does not silently mean “more tension.”

## State model

Idle → Targeting → Armed → Adjusting → Preview → Committed.
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

## Related pages

[Wiki map](README.md) · [Architecture](architecture.md) · [Adaptation](adaptation.md) · [Acceptance](acceptance.md)
