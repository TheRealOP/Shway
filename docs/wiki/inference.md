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
undo). Still planned: choosing a transcription provider/worker, real creator speech, linked audio
and multi-source sync in takes, and persisting the take index.

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
