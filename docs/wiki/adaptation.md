# Adaptation

## What learns first

Calibrate handedness, comfortable rotation range, dead zone, thresholds, smoothing, and scalar gain.
Keep command recognition separate from contextual command binding.

Demonstrate one correction:
“Smaller movements should make smaller changes.”
Apply the chosen sensitivity change, replay the same action, and allow reset.

Store creative feedback with the rejected source range, reason, accepted replacement, and context.
“Prefer conversational delivery here” is not automatically a universal rule for every project.

## Bounded feedback loop

1. Log proposal, gesture trace, explicit correction, acceptance, and subsequent undo.
2. Have the LLM propose a structured patch to allowed profile fields.
3. Validate limits and replay calibration and held-out neutral/rest traces.
4. Compare task success, false activations, and latency.
5. Adopt between actions, version the profile, and retain the baseline.

Freeze the profile during an active gesture. An isolated undo is ambiguous and does not retrain
the system. A changed command meaning requires explicit acceptance.

## Framework scope

The initial loop is Harness²-inspired, not an actual Harness² integration.
[Harness²](https://github.com/google-research/harness2) can later improve the intent interpreter's
prompts and tool guidance using offline sandbox tasks. It is not a ready-made gesture learner.
Do not let it rewrite the active editor while a user performs an edit.

Swirl-Dynamics is not selected for this build. A calibrated temporal recognizer is the direct
tool for personalized gesture recognition; a learned classifier is future work.

## Related pages

[Wiki map](README.md) · [Interactions](interactions.md) · [Inference](inference.md) · [Acceptance](acceptance.md) · [YAGNI](yagni.md)
