# Implementation gates

Solo build, submission Sunday morning October 11, 2026; exact cutoff unknown.
Budget **20–35 focused hours** for the core demo assuming the fork works with the chosen media.
This is an estimate, not a guarantee. Reserve at least the last three hours for delivery.

Current evidence: the browser synthetic foundation workflow passes; actual creator-media checks
remain open. See [foundation evidence](foundation-evidence.md).

## Core gates

| Gate | Estimate | Tickets | Exit condition |
| --- | --- | --- | --- |
| Foundation + adapter | 2–4 h | [DEV-86](https://linear.app/dev-system/issue/DEV-86) / [DEV-87](https://linear.app/dev-system/issue/DEV-87) | Real import/play/edit/undo/export; validated coherent history |
| Footage + first cut | 5–8 h | [DEV-88](https://linear.app/dev-system/issue/DEV-88) / [DEV-89](https://linear.app/dev-system/issue/DEV-89) / [DEV-90](https://linear.app/dev-system/issue/DEV-90) | Word-timed index, editable brief, actual playable first cut |
| Hand interactions | 3–5 h | [DEV-91](https://linear.app/dev-system/issue/DEV-91) | Comfortable twist scrub and contextual swipe; safe tracking loss |
| Creative revision | 4–7 h | [DEV-92](https://linear.app/dev-system/issue/DEV-92) / [DEV-93](https://linear.app/dev-system/issue/DEV-93) | Gesture + voice replacement, preview/undo, precise controls retained |
| Delivery | 4–6 h | [DEV-98](https://linear.app/dev-system/issue/DEV-98) | Verified export, rehearsed flow, backup recording, submission |

Foundation → adapter → source index → brief / first cut → gesture + voice revision → export.
At the two-hour checkpoint, decide the viable backend.
If a gate overruns, narrow the demo before expanding feature scope.

## Refinement

Allow roughly 15–30 additional focused hours across exposure/music, calibration feedback,
and TRIBE setup/integration. Runtime remains unknown until measured.
Spend up to one hour testing GPU feasibility early; let genuine baseline inference run in the background.

| Tickets | Result |
| --- | --- |
| [DEV-94](https://linear.app/dev-system/issue/DEV-94) | Exposure correction and dialogue-aware music refinement |
| [DEV-95](https://linear.app/dev-system/issue/DEV-95) | One gesture sensitivity correction and scoped creative preference |
| [DEV-96](https://linear.app/dev-system/issue/DEV-96) / [DEV-97](https://linear.app/dev-system/issue/DEV-97) | GPU benchmark and version-bound TRIBE comparison |

## Future backlog

- [DEV-99: Integrate actual Harness² for offline intent-interpreter refinement](https://linear.app/dev-system/issue/DEV-99)
- [DEV-100: Train personalized temporal gesture recognition from calibrated examples](https://linear.app/dev-system/issue/DEV-100)
- [DEV-101: Evaluate TRIBE reference-response similarity with creator and viewer feedback](https://linear.app/dev-system/issue/DEV-101)
- [DEV-102: Add performed automation curves and rhythm-based editing](https://linear.app/dev-system/issue/DEV-102)
- [DEV-103: Prototype phone and EMG input adapters using the same interaction contract](https://linear.app/dev-system/issue/DEV-103)

## Working rule

Read acceptance criteria in Linear before implementing. Keep future tickets in the backlog.
Update status only after the behavior is demonstrated and checks pass.
See [YAGNI](yagni.md) before adding dependencies or abstractions.

## Related pages

[Wiki map](README.md) · [Product](product.md) · [Architecture](architecture.md) · [Acceptance](acceptance.md) · [YAGNI](yagni.md)
