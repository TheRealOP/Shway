# Inference and GPU jobs

## Creative reasoning

A hosted multimodal model initially receives the StoryBrief, source index, sampled audiovisual
content, current selection, and explicit corrections. It returns a structured EditProposal.
The adapter validates it before preview or commit. Provider/model selection is still open.

Use the model at action boundaries. Scrubbing and scalar adjustments do not wait for an LLM.

## Speech transcription

Extract source speech and obtain word timings asynchronously.
Import through Filmcraft's documented transcript.set command; verify behavior with actual source IDs.
Built-in Whisper is optional and unavailable in the browser build.
Prefer the separate GPU for transcription when feasible; a hosted API is a fallback.

**Status (DEV-88, import/indexing only):** the provider-neutral transcript format, tick conversion,
`importTranscript` via `transcript.set`, and the script-to-take index are implemented in
[`shway/takes.ts`](../../shway/takes.ts) and the [adapter](../../shway/README.md). Verified on
October 10, 2026: `node --test shway/*.test.ts` (22 tests; 36 guard mutations each fail a test) and
`foundation.mjs --transcripts --proposals` in Chrome against the generated 3 s fixture and a same-day
wasm build reused from a parallel lane (DEV-88 changes no Rust) (all 21 gates,
including exact sequence ticks, one undo step, `transcript.search`, three takes per statement, and
undo). Still planned: real creator speech, linked audio and multi-source sync in takes, and
persisting the take index.

**Status (DEV-88, local transcription):** the provider is FilmCraft's built-in Whisper. It runs
headlessly through `filmcraft-cli`, built with `--features whisper`, via
[`shway/transcribe-local.mjs`](../../shway/transcribe-local.mjs). The weights are whisper-base
(293 MB), MIT/Apache-2.0, downloaded once and never committed. It runs on the CPU, not the GPU
worker. Verified on October 10, 2026, on an Apple M2 with a 5.37 s `say` fixture:

- all 16 words were correct, with monotonic tick times from 0.05 s to 5.34 s;
- a run took 4.8 s;
- `parseTranscript` accepted the output;
- `indexTakes` scored all three script lines at 1.00.

Commands and limits are in the [Shway README](../../shway/README.md). Not yet verified: creator
footage, noisy audio, long clips, and timing accuracy against a hand-labelled reference. The
browser build has no speech, so transcripts are made offline and imported with `transcript.set`.

## First-cut take choice

**Status (DEV-89 planning and DEV-90 assembly glue verified on synthetic media):** [`shway/firstcut.ts`](../../shway/firstcut.ts)
validates an editable StoryBrief and asks the model, through the local Gemini proxy, to choose one
indexed take per script statement by opaque number. Output is checked strictly (one valid,
statement-matching take per statement, no extra fields, one retry with the error) and every range
time comes from the take index. Verified October 10, 2026: 23 `firstcut.test.ts` tests (fake model:
happy path, invented/wrong-statement/duplicate/missing choices, non-JSON, retry outcomes, hostile
briefs and takes; 15 of 16 guard mutations fail a test, the survivor is a defensive rethrow), and one
live `gemini-3.8-flash` call on the synthetic three-take fixture that returned
`{choices:[{statementIndex, take, reason}]}`, passed validation first time, and avoided the "uh" take.
`assembleFirstCut` frame-aligns the ranges and stages them via DEV-90's `adapter.assemble`.
**Browser end-to-end verified** October 10, 2026 (Chrome pane, wasm release build of this branch,
generated 25 s 24 fps fixture plus the synthetic transcript, one more live Gemini call):
`importTranscript` → `indexTakes` (6 takes) → `planFirstCut` chose the clean statement-0 take and the
"!" statement-1 take (skipping "uh") → preview token 1 placed 2 V + 2 A clips back to back
(`sourceOut` widened to the 24 fps grid), with the accepted sequence unchanged → `commit` →
one `undo` ("AI first cut") restored the empty sequence. Not verified: real creator speech,
export of the cut, and brief-driven duration limits (the model sees `durationSeconds` but nothing
enforces it).

## TRIBE flow

Tabled for the hackathon (October 11, 2026): too slow for the time left. See [Decisions](decisions.md).

1. Render the actual version, including accepted cuts, effects, and sound.
2. Submit the render to the separate Python GPU worker.
3. Load pretrained TRIBE v2 and generate predicted cortical responses over time.
4. Save results with rendered hash, model version, preprocessing, sequence mapping, and timestamp.
5. Display modeled responses and A/B differences beside the matching timeline version.

TRIBE's upstream wrapper predicts an average subject on the fsaverage5 mesh.
Its README documents a five-second alignment offset for hemodynamic lag.
Check returned alignment before displaying it; do not compensate twice.

Do not call average activation “engagement,” “suspense,” or “quality.”
Actual viewer comprehension and emotion require separate feedback.

## Minimal service proposal

POST /jobs submits transcription or analysis and returns a job ID.
GET /jobs/{id} returns queued/running/complete/failed status and result metadata.
This interface is proposed, not implemented. Use a content/version key to avoid duplicate analysis,
bounded jobs, clear failures, and a result reference rather than giant model output in the UI.

Editing continues during inference. Changed renders invalidate displayed analysis.
If live inference is slow, use genuine cached results for those exact renders, labeled as cached.

## Comparison events

A comparison of one render against an approved reference becomes zero or more **events** ("virtual
gestures"). The panel treats them as a third input next to hands and voice. Codex owns producing them
(DEV-96/97); `surface/demo.mjs` owns consuming them (`readTribeEvent`, `createTribeGate`). Version 1:

```json
{"version": 1, "id": "evt-…", "kind": "below-reference", "sequence": 7, "revision": 12,
 "renderId": "sha256:…", "range": {"start": 0, "end": 254016000000}, "score": 0.42,
 "reference": "ref-id@rev", "model": "tribev2@<checkpoint>+<code sha>"}
```

- `kind` is `below-reference` or `above-reference`: the predicted average-viewer response over `range`
  differs from the creator's approved reference. It is never "boring", "engaging" or "low quality".
- `sequence` and `revision` are the timeline the render was made from (`project.inspect`). `range` is in
  sequence ticks. `score` is the divergence, normalised to 0–1. Strings are 1–128 characters.
  Unknown fields are ignored, so evidence can be added without a version bump.
- **Rules (gate):**
  1. A malformed event is dropped.
  2. A stale event is dropped: sequence or revision no longer current.
  3. A duplicate is dropped: same `id`, or the same render and range.
  4. While a proposal is pending, or the creator is mid-gesture or mid-utterance, the event is
     deferred (not remembered).
- **Effect:** the clip under the middle of `range` gets a replacement decision. The decider is
  Gemini today and Jev by candidate id later. It may decline. A preview is shown as a *suggestion*:
  it never displaces a pending proposal, never commits, and is accepted or rejected only by the creator.
- **Delivery:** for now, a JSON file (one event or an array of them) in the panel, or
  `shwayDemo.tribe(event)`. The transport from the GPU worker is not decided.

Verified 2026-10-10 in the browser engine with a **replayed, hand-made** event, not TRIBE output; see
[acceptance](acceptance.md).

## Early benchmark

Try one short baseline render; record GPU model, peak memory, preprocessing time, inference time,
and total time. If memory is tight, run transcription and TRIBE sequentially.
Never invent a minimum VRAM requirement or inference speed without evidence.

## Distribution

[TRIBE v2](https://github.com/facebookresearch/tribev2) is CC BY-NC 4.0.
Keep its code/weights outside the permissively licensed editor as a separately configured research
service; preserve its terms and attribution. Separation does not remove the noncommercial restriction.
Do not commit weights, demo recordings, credentials, or private user media.

## Related pages

[Wiki map](README.md) · [Product](product.md) · [Architecture](architecture.md) · [Acceptance](acceptance.md) · [Decisions](decisions.md)
