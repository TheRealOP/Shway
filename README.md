# Shway

**Edit video by talking to it and pointing at it.** Shway is an AI video editor you direct with your
voice, your hands and plain-language notes. The AI does the routine cutting; you keep the decisions
and every precise editing tool.

Shway is built on [FilmCraft](https://github.com/storytold/filmcraft), an open-source, pure-Rust
non-linear editor. FilmCraft owns the project, exact edit time, rendering, undo and export. Shway
adds a TypeScript interaction layer, a chat assistant and a local AI proxy on top. Every AI change
is a normal, previewed, undoable FilmCraft edit.

[Knowledge graph and wiki](docs/wiki/README.md) ·
[Product](docs/wiki/product.md) ·
[Implementation gates](docs/wiki/implementation.md) ·
[Architecture](docs/wiki/architecture.md) ·
[Handoff](docs/HANDOFF.md) ·
[Linear backlog](https://linear.app/dev-system/project/schway-4deadf7f36cc)

Agents: read [AGENTS.md](AGENTS.md), [CLAUDE.md](CLAUDE.md) and [YAGNI](docs/wiki/yagni.md) before
implementation.

> [!NOTE]
> **Screenshot placeholder: the Shway workspace.**
> A dark, minimal editor. The Program monitor fills the top of the window and the timeline sits
> below it. The chat assistant panel is docked at the bottom: the creator types "cut the part where
> I trip over my words", and the assistant replies with a proposed edit and **Accept / Reject** buttons.

## How it works

1. **Import** your speaking takes and supporting footage, for example a folder of iPhone `.MOV` clips.
2. **Describe the story.** Give the message, audience, feeling and length in a short story brief.
3. **Watch a real first cut.** Shway transcribes every clip locally, then asks the model for a
   hook / intro / body / ending order built from transcript segments. The result is placed on the
   timeline as real, source-backed edits.
4. **Direct the revision.** Twist your hand to scrub, swipe to step between edits, or hold a pinch and say
   *"That sounds rehearsed; use the take where I laugh."*
5. **Preview, then decide.** Each change is staged as a preview first. Accept commits it as a single
   undo step; reject discards it.
6. **Export** to H.264 + AAC.

> [!NOTE]
> **Screenshot placeholder: the first cut.**
> The timeline right after "Make a first cut": a row of clips on V1 with linked dialogue on A1, in
> recording order. Each clip carries the label of its story beat (hook, intro, body, ending). The
> Program monitor shows the opening frame.

## What Shway adds

| Piece | What it does | Where |
| --- | --- | --- |
| **Chat assistant** | Chat with the AI from inside the desktop editor. It replies and proposes edits: trim, remove, move, place or replace a take. Each proposal is previewed with Accept and Reject. | [`shway/assistant.mjs`](shway/README.md#chat-assistant-assistantmjs), the assistant panel in `ui-egui` |
| **AI first cut** | Builds a story-ordered cut from word-timed transcripts. Long-form mode handles many clips and orders iPhone clips by their QuickTime recording dates. | [`shway/firstcut.ts`](shway/README.md#story-brief-and-ai-first-cut-dev-89--dev-90), [`shway/longform.mjs`](shway/README.md#long-form-first-cut-from-many-clips-longformmjs) |
| **Take replacement** | Turns a spoken correction and the current selection into a previewed swap between alternative takes of the same line. | [`shway/replace.ts`](shway/README.md#take-replacement-dev-92) |
| **Hand gestures** | Camera hand tracking. Pinch + twist shuttles the playhead, swipe steps between edits, chop cuts, and double tap plays or pauses. A still pinch starts push-to-talk. | [`surface/gestures`](surface/gestures/README.md) |
| **Voice** | Push-to-talk capture tied to the current selection and recent gestures. Speech is transcribed by FilmCraft's built-in Whisper or through the proxy. | [`surface/voice`](surface/voice/README.md) |
| **Engine adapter** | A narrow typed boundary over FilmCraft's commands. Proposals are allowlisted, bounded and checked against the project revision, and Rust stages them in a disposable session. | [`shway/adapter.ts`](shway/README.md) |
| **Model proxy** | A local server that holds the API keys for Gemini (creative reasoning, transcription) and Jev. It also hands rendered versions off to TRIBE for analysis. | [`shway/gemini-server.mjs`](shway/README.md#gemini-proxy-creative-reasoning) |
| **Demo page** | The browser build of the editor with a side panel for camera, gestures, push-to-talk, the story brief and pending proposals. | [`surface/demo.html`](surface/README.md) |

> [!NOTE]
> **Screenshot placeholder: a gesture-driven replacement.**
> The demo page. The webcam overlay in the side panel shows a tracked hand with the mode line
> reading `Armed: pinch held`. A recording bar shows the spoken correction. Above the timeline, the
> preview bar reads *"Replace take 2 with take 3 (laughing)"*. The Program monitor already plays the
> candidate take, and the timeline is unchanged until the creator double-taps to accept.

> [!NOTE]
> **Screenshot placeholder: undo after accept.**
> The same timeline after Accept, then after one Cmd+Z. The edit history shows the AI change as a
> single entry, and undoing it restores the original take exactly.

## Get started

**Desktop editor with the chat assistant.** Run each command in its own terminal:

```sh
cargo run --release -p filmcraft -- --control 9876 project.fcproj   # the editor with the control server
node shway/gemini-server.mjs --port 8790                            # model proxy; reads GEMINI_API_KEY from .env
node shway/assistant.mjs --port 8793 --editor 127.0.0.1:9876 --proxy http://127.0.0.1:8790
```

**Long-form first cut from a folder of clips:**

```sh
node shway/transcribe-local.mjs clip.mp4 --source-item 41 --language en --out clip.transcript.json
node shway/longform.mjs segments|plan|assemble|compare|test    # usage in the file header
```

**Browser demo with camera and microphone:**

```sh
cargo xtask web
node surface/build-demo.mjs <editor dist> --out target/demo
python3 -m http.server -d target/demo 8765 --bind 127.0.0.1    # then open http://127.0.0.1:8765/demo.html
```

**Tests:**

```sh
node --test shway/*.test.ts shway/*.test.mjs surface/demo.test.mjs
cargo xtask ci        # FilmCraft gates: fmt, clippy, tests, layers, assets, wasm
```

Node 23 or later is needed (Node 26 for `shway/build.mjs`). Full details, flags and the contract
for every route are in [`shway/README.md`](shway/README.md) and [`surface/README.md`](surface/README.md).

## Status

Shway is a young hackathon project. Status is tracked honestly: a feature counts as verified only
when there is evidence for it. See [Foundation evidence](docs/wiki/foundation-evidence.md) and
[Implementation](docs/wiki/implementation.md); Linear is the source of truth for task status.

- **Verified:** browser build plus import → play → edit → undo → save → reopen → H.264/AAC export
  on generated fixtures. Take replacement worked end to end in the real browser engine, including a
  live transcription and a live model choice. The chat assistant previewed, accepted, rejected and
  undid remove/move edits live. TRIBE handoff ran from one saved project.
- **Replay-tested only:** gesture recognition and push-to-talk pass synthetic replay tests.
  Live camera tracking, gesture latency and speaker bleed are not yet measured.
- **Later:** generative relighting, broad autonomous story reconstruction, reference matching,
  and phone or EMG input.

TRIBE predicts neural responses to rendered media. It does not read the creator's thoughts or
prove which edit will cause a particular emotion.

## Under the hood: FilmCraft

Shway inherits FilmCraft's editor: Premiere-style panels and shortcuts, its own H.264, HEVC, ProRes
and AAC codecs written in Rust, a linear-light GPU compositor, exact integer time
(`filmcraft_time::Tick`), and 650+ engine commands. The UI, the CLI, the JSON control channel and
MCP all dispatch those same commands, and Shway uses that command surface rather than a separate timeline.

| | |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | Layers, data model, time base, command system, render and export |
| [docs/control-protocol.md](docs/control-protocol.md) | Control channel and MCP reference |
| [docs/agents.md](docs/agents.md) | Driving the editor from agents |
| [docs/web.md](docs/web.md) | WebAssembly build |
| [docs/testing.md](docs/testing.md) · [docs/contributing.md](docs/contributing.md) | Tests and contributor setup |
| [ROADMAP.md](ROADMAP.md) | FilmCraft's own roadmap and honest assessment |

Japanese UI and title text needs the optional [craft-fonts](https://github.com/storytold/craft-fonts)
build input: `CRAFT_FONTS_DIR="$PWD/../craft-fonts" cargo run -p filmcraft`.

## License and credits

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option. FilmCraft is
Copyright (c) 2026 ArtCraft Team and the FilmCraft contributors; required notices are in
[NOTICE](NOTICE). Bundled assets keep their own open licenses and are listed in
[ATTRIBUTION.md](ATTRIBUTION.md).

FilmCraft is an independent, clean-room implementation. It contains no Adobe code or assets and no
GPL or LGPL code, and ffmpeg is used only as an external test oracle. The ArtCraft name and logos
are trademarks of the ArtCraft Team and are not part of Shway.

<sub>Adobe and Premiere Pro are trademarks of Adobe Inc. Shway and FilmCraft are not affiliated
with or endorsed by Adobe Inc.</sub>
