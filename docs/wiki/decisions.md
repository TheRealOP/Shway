# Decisions and open questions

Snapshot: October 10, 2026. Update these entries when evidence or user direction changes.

| Decision | Status | Reason / verification |
| --- | --- | --- |
| Fork Filmcraft | Selected | Reuse Rust editor; baseline 7bd76212629a067a9d1c5426d751de9faf4664b7; fork exists |
| AI first cut + creator-directed revisions | Selected | Matches the creator's recording-to-edit workflow |
| Camera hands + voice | Selected | Available input; twist scrubs and swipes navigate |
| Browser surface first | Provisional | Must pass import/play/edit/undo/export; native + bridge fallback |
| Separate GPU inference worker | Planned | Keeps TRIBE/transcription off the live editor path |
| Hosted multimodal reasoning | Planned | Shortest initial path; provider and model still open |
| Bounded profile adaptation | Planned | Explicit, testable personalization without autonomous rewrites |
| Full Harness² / learned recognizer / phone / EMG | Deferred | Beyond the first complete workflow |
| YAGNI | Selected | User requested minimal implementation guidance |
| Ponytail skill | Unresolved, optional | Exact skill reference not available; use YAGNI |

## Resolve through early checks

- Exact Sunday submission time and event policy on pre-existing editor code.
- GPU location, model, memory, and connectivity.
- Browser performance and export behavior on the real demo footage.
- Command grouping/transaction support and replacement-duration behavior.
- ASR and hosted reasoning credentials and working providers.
- Actual TRIBE preprocessing, memory, runtime, and time alignment.

## Evidence log

Only the fork and planning backlog are confirmed here.
Record future results as: date, commit, hardware/fixture, action, outcome, and limitations.
Do not rewrite an upstream marketing claim as a locally verified result.

## Related pages

[Wiki map](README.md) · [Architecture](architecture.md) · [Inference](inference.md) · [Implementation](implementation.md) · [YAGNI](yagni.md)
