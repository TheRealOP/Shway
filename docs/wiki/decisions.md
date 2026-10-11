# Decisions and open questions

Snapshot: October 10, 2026. Update these entries when evidence or user direction changes.

| Decision | Status | Reason / verification |
| --- | --- | --- |
| Fork Filmcraft | Selected | Reuse Rust editor; baseline 7bd76212629a067a9d1c5426d751de9faf4664b7; fork exists |
| AI first cut + creator-directed revisions | Selected | Matches the creator's recording-to-edit workflow |
| Camera hands + voice | Selected | Available input; twist scrubs and swipes navigate |
| Browser surface first | Viable on synthetic fixture | WebGPU import/play/edit/undo/save/reopen/H.264+AAC export passes locally; warmed synthetic playback measured 23.72 displayed frames/s; actual footage still needs verification |
| Separate GPU inference worker | Planned | Keeps TRIBE/transcription off the live editor path |
| Hosted multimodal reasoning | Planned | Shortest initial path; provider and model still open |
| Bounded profile adaptation | Planned | Explicit, testable personalization without autonomous rewrites |
| Full Harness² / learned recognizer / phone / EMG | Deferred | Beyond the first complete workflow |
| TRIBE analysis | Tabled for the hackathon (October 11, 2026) | Inference (about 5 min per 12 s clip on GPU) is too slow for the time left; DEV-96/97/109/118/119/120/121 moved to Backlog. The demo ships without it |
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

The browser foundation workflow is verified on a synthetic fixture; see
[foundation evidence](foundation-evidence.md) for exact scope and reproduction.
Record future results as: date, commit, hardware/fixture, action, outcome, and limitations.
Do not rewrite an upstream marketing claim as a locally verified result.

## Related pages

[Wiki map](README.md) · [Architecture](architecture.md) · [Inference](inference.md) · [Implementation](implementation.md) · [YAGNI](yagni.md)
