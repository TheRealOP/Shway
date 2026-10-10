# Acceptance and verification

Current local results: [foundation evidence](foundation-evidence.md).

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
