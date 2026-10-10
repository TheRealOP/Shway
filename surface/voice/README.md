# Push-to-talk voice capture (DEV-92 slice)

Explicit push-to-talk in, utterances bound to the interaction context out. No editor calls, no
speech-to-text provider. Contract: [interactions](../../docs/wiki/interactions.md) (voice fusion).

| File | What |
| --- | --- |
| `utterance.mjs` | Pure, deterministic utterance state (`createVoice`). Runs in Node and browsers, no build step. |
| `utterance.test.mjs` | Replay tests: `node --test surface/voice/utterance.test.mjs` (Node ≥ 22, no packages). |
| `mic.mjs` | Browser-only microphone open and one-`MediaRecorder`-per-utterance capture, shared by `voice.html` and `../demo.html`. |
| `voice.html` | Microphone harness: hold V or the button, recording indicator + level meter, utterance list with playback. |

Serve on localhost (the microphone needs a secure context):
`python3 -m http.server -d surface 8771` → `http://127.0.0.1:8771/voice/voice.html`.

## Behaviour

- **Push-to-talk only.** An utterance exists only between an explicit `start` (source `key`, `gesture`
  or `button`) and `stop`. Any other source (e.g. an automatic voice-activity start) is rejected, and
  `stop`/`tick`/key-up while idle produce nothing. The harness creates a `MediaRecorder` only on
  start, so playback audio outside a held push-to-talk is never recorded. While held,
  `echoCancellation` reduces speaker bleed; it does not make playback safe to record, so keep playback
  paused or quiet while talking (not yet measured).
- **Key hold:** `KeyV` by default (`createVoice({key})`). Key repeat is ignored. Key-up ends only a
  key-started utterance. Window blur cancels (a lost key-up must not leave the mic recording). Esc cancels.
- **Caps:** shorter than `minMs` (300) → `rejected: too-short`. `maxMs` (15 s) ends the utterance at
  exactly `startT + maxMs` with `capped: true` (via `tick` or a late `stop`).
- **Context:** the caller's context is `structuredClone`d at start, so later selection changes
  don't leak in. Uncloneable context → `rejected: bad-context`.
- **Gestures:** `gesture(e)` buffers recognizer events (bounded, 64). An utterance carries those with
  `startT − preMs (2 s) ≤ t ≤ endT`. Gestures after release are not attached.
- **Hostile input:** non-finite or backwards time, bad config, malformed gesture events are rejected
  or dropped, never thrown.

## Integration boundary (for DEV-92)

```js
import { createVoice } from "./utterance.mjs";
const voice = createVoice(/* {key, minMs, maxMs, preMs, maxGestures} */);
voice.start(t, context, "gesture");  // e.g. on a reject gesture; → {type:"recording", id} | {type:"rejected", reason}
voice.stop(t);                       // → {type:"utterance", utterance} | {type:"rejected", reason}
voice.cancel(t); voice.tick(t);      // tick: call each frame while recording (enforces maxMs)
voice.key(t, code, down, context);   // push-to-talk key
voice.gesture(gestureEvent);         // forward every surface/gestures event (same performance.now() clock)
```

Utterance: `{id, source, startT, endT, capped, context, gestures, audio, transcript}`. `audio` is
the recorded `Blob` (set by the harness after `MediaRecorder` stops). `transcript` stays `null`
until a provider fills it with `{text, words?}`.

`voice.html` exposes `window.shwayVoice`: `start()`, `stop()`, `cancel()`, `gesture(e)`,
`setContext(() => context)`, `setSink(fn)` (receives each utterance with its audio), and
`setTranscriber(async (blob) => ({text, words}))`. The default transcriber throws
"no speech-to-text provider configured".

Suggested context (from `shway/adapter.ts` inspection): `{revision, sequence, selection: [clipId],
target: clipId | null, playhead: ticks, gesture: recognizer.view().state}`. DEV-92 still decides
how a transcript plus context becomes an `EditProposal`. "This" resolves to `context.target`. With
no or several selected clips the proposal must ask for an explicit selection; this module does not
resolve targets.

## Status and evidence (2026-10-10)

- **Verified:** 9 replay tests pass (Node 26.4). Mutation-checked: each of 19 guards (backwards time,
  source allow-list, double start, context snapshot, min/max caps in `stop` and `tick`, key repeat,
  key-up source check, both gesture window bounds, buffer bound, config validation, min ≤ max, buffer
  ceiling, gesture time order, idle stop, cancel clearing, key validation) fails ≥ 1 test when removed.
- **Verified:** `voice.html` loads without console errors in Claude's browser pane. It reports
  microphone denial (`NotAllowedError`); holding V without a mic records nothing and says so.
- **Not verified (blocked):** live microphone capture, `MediaRecorder` output, level meter and
  playback. The browser pane blocks the microphone; open the page in a normal browser on the Mac.
  Also unmeasured: speaker bleed while held, and gesture-started capture end to end.
- **Not built:** speech-to-text (no provider chosen), target resolution, proposal creation.

## Related

[Interactions](../../docs/wiki/interactions.md) · [Gestures](../gestures/README.md) · [Adapter](../../shway/README.md)
