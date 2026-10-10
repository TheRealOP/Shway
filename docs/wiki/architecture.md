# Architecture

## Ownership

Filmcraft's Rust engine owns the authoritative project, source media, timeline, commands, rendering,
and undo history. AI, gestures, and traditional controls act on that same project.
Do not create a competing timeline or editing engine.

| Component | Planned location | Responsibility |
| --- | --- | --- |
| Filmcraft + interaction surface | Mac | Edit, play, preview, export, track hands, collect voice |
| Transcription worker | Separate GPU machine, or hosted fallback | Word-timed source transcripts |
| TRIBE Python worker | Separate GPU machine | Asynchronous analysis of rendered audio/video |
| Multimodal intent model | Hosted API initially | Brief interpretation and grounded edit proposals |

The separate GPU's model and memory remain unknown. The Mac's GPU supports native visual rendering.
Do not assume GPU transcription and TRIBE can stay resident together; benchmark memory and queue jobs.

## Backend gate

First try the browser build and a TypeScript interaction surface beside the editor.
Pass import/play/edit/undo/export with the demo footage before committing to that path.

If that fails, use the native desktop editor with a local bridge.
The browser surface calls the bridge, and the bridge speaks the desktop JSON-lines TCP control
protocol. Browsers cannot directly use raw TCP. Implement one adapter, not two complete apps.

## Minimal contracts

- **MediaIndex / Take:** source ID, path, source range, word timings, statement group, linked audio.
- **StoryBrief:** creator's editable goals and constraints.
- **InteractionContext:** mode, selected clip/interval, engagement, confidence, observation timestamps.
- **EditProposal:** expected project revision, explicit targets, supported commands, bounded parameters,
  source provenance, and explanation.
- **GestureProfile / CreativePreferences:** versioned calibration and scoped accepted corrections.
- **ProjectVersion / AnalysisJob:** rendered content hash, model and preprocessing versions,
  sequence mapping, status, and timestamp.

Discover commands at runtime and verify each demonstrated operation. Validate clip references,
source durations, linked audio, and finite numeric parameters. Reject stale revisions.

## Time and history

Keep source media IDs distinct from timeline clip IDs. Convert source time and sequence time explicitly.
Rust edit math remains exact Tick time; numeric sensor timestamps are not edit-time arithmetic.

A preview is reversible; a commit is one understandable undo operation.
Do not assume command batches are atomic. If grouping is absent, add a small Rust preview/commit
boundary instead of streaming hundreds of independent history edits.

A replacement that is shorter than the retained timeline duration must be previewed and re-planned;
never silently freeze its final frame.

## Source anchors

[Engine architecture](../architecture.md) · [Browser API](../web.md) ·
[Desktop protocol](../control-protocol.md) · [Transcript import](../transcripts.md).
Read these and the touched crate's source before deciding an API exists.

## Related pages

[Wiki map](README.md) · [Implementation](implementation.md) · [Interactions](interactions.md) · [Inference](inference.md) · [Decisions](decisions.md)
