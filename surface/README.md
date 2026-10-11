# Shway surface: the live demo page

`demo.html` is the one page for the creator's demo. The real editor fills the page. A side panel
(below the editor at phone width) holds everything Shway adds. Contract: [interactions](../docs/wiki/interactions.md).

| File | What |
| --- | --- |
| `demo.html` | Editor iframe (same origin) + panel: preview bar, camera and hand overlay, gesture mode/target/effect, push-to-talk, story brief, editor and Gemini status. |
| `demo.mjs` | DOM-free logic: hold-to-talk, brief validation, the pending-proposal controller, hook loading. Tests: `node --test surface/demo.test.mjs`. |
| `build-demo.mjs` | Assembles a servable dist from a prebuilt editor dist. |
| `gestures/` | Recognizer, editor bridge + ink, the demo page's browser camera (`hands.mjs`). [README](gestures/README.md) |
| `voice/` | Push-to-talk utterances, shared recorder (`mic.mjs`), microphone harness. [README](voice/README.md) |

## Run it

```sh
cargo xtask web                                  # once: builds the editor dist (see docs/web.md)
node surface/build-demo.mjs <editor dist> --out target/demo   # copies it; never modifies the source
node shway/gemini-server.mjs --port 8790         # optional: first cut and replacement need Gemini
python3 -m http.server -d target/demo 8765 --bind 127.0.0.1
# open http://127.0.0.1:8765/demo.html in a normal browser (camera and microphone need a real one)
```

`--out` must be inside this checkout's `target/` or `dist/` (`shway/build.mjs` enforces it). Media
fixtures (`web-test.mp4` …) come from the editor dist; never commit them.

## Keys and gestures

The camera is off until you press **Turn camera on** in the Hands section. Everything else (mouse,
keys, push-to-talk, typed corrections, first cut, TRIBE suggestions) works without it. Turning it off
stops the camera and is handled like tracking loss first: a shuttle stops where it is, and a
🤘-started recording is cancelled. Then the hand state returns to Idle. A refused or missing camera leaves the toggle off with a note.

The editor keeps the keyboard while it has focus: Space, J/K/L, Cmd+Z, and the other editor keys work as usual.
Click the panel to give it the keyboard. The header shows `Keys → editor` or `Keys → panel`.
Typing in a panel field never triggers shortcuts. Esc works everywhere in the panel.

| Panel key | Gesture | Effect |
| --- | --- | --- |
| `A` | double tap, only while a preview is pending | Accept: `adapter.commit` (one undo step) |
| `X` | still 🤘 held 0.8 s, only while a preview is pending | Reject: `adapter.cancel`, then talk to say why |
| `U` | — | Undo: `adapter.undo` |
| hold `V` / hold button | still 🤘 held 0.8 s (no twist) | Push-to-talk. Release ends it. Twisting or losing the hand cancels. |
| hold `Space`, `Shift` | 🤘, `Shift` | Engage / fine mode (twist needs a hand) |
| `Esc` | — | Cancel the recording or the scrub (playhead returns) |
| — | 🤘 + twist / fist, slid fist / swipe / chop / thumb–index double tap | Shuttle / pause, scrub / next or previous edit / cut / accept while a preview is pending (see [gestures](gestures/README.md)) |

Chop and swipe never accept or reject. Double tap means accept only while the preview bar shows a
proposal. The panel's `mode` line says so at that moment.

## Hooks for later flows

The panel loads these modules from the dist root. When a module is missing, it says "not available yet".

- **First cut:** `firstcut.js` (`shway/firstcut.ts`) must export `planFirstCut`, `assembleFirstCut`
  and `proxyGenerate`. The brief (message, audience, feeling, duration) plus the script (one statement
  per line) and transcript JSON files go to `indexTakes`, then
  `planFirstCut({brief, script, takes, generate})`, then `assembleFirstCut(adapter, plan)`. The plan's
  reasons are listed. A result with a `token` goes to the preview bar; any other result counts as
  already applied, and Undo reverts it. `assembleFirstCut` always returns a preview with a token and
  appends after existing content. So make an empty sequence active first. The editor build must include
  `timeline.place` (DEV-90), and `shway/build.mjs` must emit `firstcut.js` (branch `claude/dev-89-ai-first-cut`).
- **Replacement:** `replace.js` (`shway/replace.ts`) must export `proposeReplacement`, `geminiGenerate`
  and `transcribe`. It runs for every finished utterance, spoken or typed in the "type what you'd say"
  field. A spoken utterance is first transcribed (`transcribe(audio, proxy)`, which needs the proxy's
  `POST /transcribe`). Then `proposeReplacement({utterance, takes, generate, adapter})` runs. The takes
  come from the brief form's script and transcripts. `status: "preview"` goes to the preview bar,
  with its explanation shown under the voice section. `need-selection`, `no-take` and `rejected` show
  their message. Thrown errors (stale revision, engine refusals) are shown so you can re-plan.
  The utterance context is `{revision, sequence, selection, target, playhead, gesture}`. The panel
  polls `project.inspect` and `ui.inspect` every 500 ms to keep it current. `target` is set only when exactly one
  clip is selected.

`window.shwayDemo` exposes `gesture(event)`, `frame(hand, keys)`, `proposals`, `voice`, `adapter`,
`context` and `recognizer` for automation and tests.

## Status and evidence

See [acceptance](../docs/wiki/acceptance.md) for the dated status line.

## Desktop editor: camera gestures (DEV-91)

The browser review page (`review.html`) is gone: for the desktop editor the webcam runs natively,
started by `node shway/assistant.mjs --port 8793 --editor 127.0.0.1:9876 --proxy http://127.0.0.1:8790 --camera` (see [gestures](gestures/README.md)).
Its push-to-talk voice went with it; voice is unavailable on the desktop path until it moves into
the native path too (Track D). Chat in the editor's chat panel still works. The assistant's
`POST /review/stop|note|cancel` routes stay for that.
