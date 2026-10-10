# Shway implementation handoff

Prepared October 10, 2026 for the next builder or coding agent.

**Start with DEV-86: verify the fork with real demo footage. Planning and documentation are complete;
Shway's application features have not been implemented or tested in this session.**

## Project references

- Repository: [TheRealOP/Shway](https://github.com/TheRealOP/Shway).
- [Knowledge graph and wiki](https://github.com/TheRealOP/Shway/blob/main/docs/wiki/README.md).
- [HTML implementation plan](https://github.com/TheRealOP/Shway/blob/main/docs/shway-implementation-plan.html).
  Download it or open it from a checkout in a browser; GitHub's file viewer shows source, not a hosted app.
- [AGENTS.md](https://github.com/TheRealOP/Shway/blob/main/AGENTS.md) and
  [CLAUDE.md](https://github.com/TheRealOP/Shway/blob/main/CLAUDE.md).
- [Linear project](https://linear.app/dev-system/project/schway-4deadf7f36cc), named **Schway**.
  Product/repository spelling is **Shway**; the existing Linear name was retained.
- [Full reviewed execution plan](https://linear.app/dev-system/document/shway-product-architecture-and-hackathon-execution-plan-12141d616571).

## What the creator wants

A video editor that translates creative intent into real edits through voice, hands, and references,
while retaining precise conventional tools. AI assembles a first cut from recorded speaking takes.
The creator watches, twists a hand to scrub, gestures to reject a take, and explains the desired
replacement aloud. The revision is previewed, accepted or undone, and exported.

Example: “That sounds rehearsed; use the take where I laugh, then show the result.”

The creator is building solo, has access to a GPU, and submits Sunday morning, October 11.
Exact cutoff, GPU hardware/location, and model credentials are unknown.
Camera hand tracking is selected; no EMG armband is available.
Do not reopen settled product choices without evidence or new direction.

## Current state

| Item | Evidence / remaining work |
| --- | --- |
| Public Filmcraft fork | Created; upstream baseline 7bd76212629a067a9d1c5426d751de9faf4664b7 |
| Wiki and agent guidance | Committed on main in 540af22629b974144cc949ec30dbb39eb60eb42a |
| Linear backlog | 18 tickets, dependencies, priorities, acceptance criteria, three milestones |
| HTML plan | Created and browser-checked: ticket filters, checklist persistence/reset, and width overflow check |
| Local editor build | Not attempted; no successful compile, import, playback, or export is claimed |
| Shway features / services | Planned; no command adapter, hand tracker, creative agent, or GPU service implemented |
| TRIBE | Upstream interface researched; no inference run or hardware benchmark performed |
| Test results | Wiki links and graph targets checked; no editor workspace CI or runtime verification performed |

This is a planning snapshot, not a live project-status feed. Inspect current main and Linear before
starting; other work may have happened after the handoff was written.
The planning workspace is not a cloned Shway checkout. Repository documentation was published
through the GitHub connector. Do not assume an existing local repo or working GitHub CLI login.

## First session: prove the editor

1. Read AGENTS.md, CLAUDE.md, the wiki's
   [YAGNI page](https://github.com/TheRealOP/Shway/blob/main/docs/wiki/yagni.md),
   and DEV-86 acceptance criteria.
2. Clone or locate a suitable checkout. Inspect branch, status, and any local instructions;
   preserve existing changes. Do not reset someone's work.
3. Read upstream setup docs and confirm Rust/build dependencies.
4. Build the editor and run original/open demo footage through import → playback → edit → undo → export.
5. Discover real engine commands. Verify one programmatic edit and history behavior.
6. Decide browser versus native backend using that actual workflow within the first two-hour checkpoint.
7. Record commit, hardware, fixture, outcome, failures, and selected backend in the wiki/Linear.

Documented upstream commands, to be verified in the checkout:

```sh
git clone https://github.com/TheRealOP/Shway.git
cd Shway
cargo run --release -p filmcraft
cargo run --release -p filmcraft -- --control 9876
cargo run --release -p filmcraft-cli -- commands
```

Use only one app-launch command at a time. The second variant starts the desktop JSON control server.
Filmcraft documents native macOS support; that is not proof this fork works with the creator's footage.

## Architecture to implement

| Location | Components | Contract |
| --- | --- | --- |
| Mac | Filmcraft Rust engine, interaction surface, camera/microphone input | One authoritative project, normal commands, preview and undo |
| Separate GPU machine | Python TRIBE worker; preferably transcription if feasible | Asynchronous queued jobs and version-bound results |
| Hosted model API initially | Multimodal creative reasoning | Structured, source-grounded EditProposal; validated before execution |

The Mac GPU handles native editor visual rendering. The separate GPU handles model inference.
The exact GPU and available memory still need checking. Do not assume TRIBE and transcription
can stay loaded together; benchmark, and queue them sequentially if needed.

First try Filmcraft's browser build with a TypeScript surface alongside it.
If real playback/export fails the gate, keep the surface and use a local bridge to desktop.
A browser cannot directly speak raw TCP; the bridge dispatches the JSON-lines control protocol.
Do not build two complete backends or a second editing engine.

Suggested records: StoryBrief, MediaIndex/Take, InteractionContext, EditProposal,
GestureProfile, CreativePreferences, ProjectVersion, AnalysisJob.
Suggested inference API: POST /jobs and GET /jobs/{id}; this API does not exist yet.

## Build order and ticket ownership

All core/refinement tickets are assigned to the creator. Future tickets are in Backlog.
Use current Linear status, not this document, to decide which task is available.

| Gate | Tickets | Estimate | Completion evidence |
| --- | --- | --- | --- |
| Foundation and adapter | [DEV-86](https://linear.app/dev-system/issue/DEV-86), [DEV-87](https://linear.app/dev-system/issue/DEV-87) | 2–4 h | Import/play/edit/undo/export; validated coherent preview/commit |
| Source index and first cut | [DEV-88](https://linear.app/dev-system/issue/DEV-88), [DEV-89](https://linear.app/dev-system/issue/DEV-89), [DEV-90](https://linear.app/dev-system/issue/DEV-90) | 5–8 h | Word-timed takes, editable brief, real playable first cut |
| Hand controls | [DEV-91](https://linear.app/dev-system/issue/DEV-91) | 3–5 h | Twist scrub, contextual swipe, safe tracking loss |
| Creative revision | [DEV-92](https://linear.app/dev-system/issue/DEV-92), [DEV-93](https://linear.app/dev-system/issue/DEV-93) | 4–7 h | Gesture + voice replacement; preview/undo; conventional controls retained |
| Delivery | [DEV-98](https://linear.app/dev-system/issue/DEV-98) | 4–6 h | Verified real export, rehearsed demo, backup recording, submission |

Core estimate: **20–35 focused hours**, assuming the fork works.
Protect the final three hours for validation, recording, and submission.
Use a 20–40 second scene, three alternative speaking takes, and a little supporting footage.
If time contracts, reduce the footage and demonstrated operations before adding more subsystems.

After the core works:
- [DEV-94](https://linear.app/dev-system/issue/DEV-94): exposure correction and dialogue-aware music refinement.
- [DEV-95](https://linear.app/dev-system/issue/DEV-95): one sensitivity correction and one scoped creative preference.
- [DEV-96](https://linear.app/dev-system/issue/DEV-96) /
  [DEV-97](https://linear.app/dev-system/issue/DEV-97): TRIBE feasibility and exact-version comparison.
  Try one short baseline inference early, then let the job run during editor work.

Combined refinement may add 15–30 focused hours; TRIBE setup/runtime is the largest unknown.
DEV-99 through DEV-103 cover later Harness² integration, learned gesture recognition,
reference-response experiments, performed curves/rhythm, and phone/EMG inputs.

## Critical integration details

- Use external asynchronous ASR and import word timings through transcript.set.
  Built-in Whisper is optional and unavailable in the browser build.
- Keep original source IDs/ranges distinct from timeline clip IDs.
  Convert source and sequence time explicitly; Rust edit math stays in exact Tick time.
- Discover supported commands; do not invent IDs or blindly trust LLM output.
  Validate revision, targets, source bounds, finite values, and linked dialogue audio.
- Take replacement may retain the old duration. A short source can produce a held final frame.
  Preview or re-plan duration; do not silently accept a frozen ending.
- Command batches are not assumed atomic. Verify grouping; add a small Rust preview/commit boundary
  if needed. One continuous gesture should be one understandable undo operation.
- Relative twist around a captured neutral orientation controls bounded signed scrub speed.
  Add dead zone, smoothing, fine control, and explicit engagement/release.
- Temporal swipes use displacement/velocity thresholds and cooldown; suppress them while twisting.
- State machine: Idle → Targeting → Armed → Adjusting → Preview → Committed,
  plus Cancelled and TrackingLost. Continuous numeric control is separate from the discrete FST.
- Low tracking confidence pauses and requires re-engagement. Resting hands do not edit.
- Start voice with push-to-talk so playback audio cannot issue commands.
  Bind “this” to the visible selection; ambiguous targets need explicit selection.
- Keep mouse, keyboard, timeline, and precise frame controls available.

## TRIBE and personalization boundaries

TRIBE runs on rendered audio/video in a separate Python GPU worker, not inside Filmcraft's live
gesture loop. Its outputs are average-subject predicted cortical responses.
It does not read the creator's mind or validate engagement, suspense, or video quality.

Store rendered hash, model/preprocessing version, time mapping, status, and timestamp.
Check the upstream five-second timing alignment; do not compensate twice.
Changed renders invalidate displayed results. Genuine cached results are acceptable when labeled
and tied to the exact demo render.

Creative intent comes from multimodal reasoning plus explicit user corrections.
Learn bounded calibration/profile fields and contextual preferences; freeze profiles during an action.
Replay held-out neutral traces before adopting changes. An undo alone is not enough to retrain.
Keep reset and prior profile versions.

The initial loop is **Harness²-inspired** until the actual framework is integrated.
Swirl-Dynamics is not required. Do not build a generic learning platform for this demo.
YAGNI is the default; Ponytail was not found locally and is optional pending its exact SKILL.md.

## Open questions to resolve

- Exact Sunday submission cutoff and event rules for a pre-existing editor base.
- GPU model, memory, host access, connectivity, and actual TRIBE memory/latency.
- Browser import/playback/export viability on the real footage.
- Engine transaction/grouping and take-replacement duration behavior.
- Working transcription and creative-model provider/credentials.
- Demo media and licensed music selection.

Never put credentials, model weights, private media, or raw recordings in the repository.

## Quality and distribution

Follow inherited safety, clean-room, layering, exact-time, asset, and license rules.
Rust runtime changes require the applicable upstream checks; documentation-only changes use
link/graph/diff checks. Add meaningful replay and invalid-input checks for gesture/editor boundaries.
Measure gesture feedback p95 separately from LLM and TRIBE timing; 150 ms is a goal, not a result.

Retain MIT/Apache licenses, NOTICE, and required attributions.
Remove protected upstream branding from modified distributions.
TRIBE is CC BY-NC 4.0; a separate service still carries its noncommercial restriction.
Do not bundle its weights as a permissive editor dependency.

## Ready-to-use continuation instruction

Read AGENTS.md, CLAUDE.md, and the wiki. Inspect current main and Linear.
Start DEV-86 by proving import/play/edit/undo/export on the actual demo media.
At the first two-hour checkpoint, choose the working editor backend.
Proceed through the command adapter, first cut, and gesture/voice replacement gates.
Use YAGNI, keep one authoritative project, retain precise controls, and record verification evidence.
