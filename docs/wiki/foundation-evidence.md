# Foundation verification evidence

Recorded October 10, 2026 for DEV-86 and the bounded DEV-87 adapter slice. This is partial acceptance evidence, not completion.

## Environment and result

- Baseline checkout: `2d2c7e631591c7843ab6a1c33a671de29fc8a019` (engine code unchanged for this run).
- Host: Apple M2 MacBook Air, 8 CPU cores, 16 GB memory, macOS arm64.
- Rust 1.99.0, wasm32-unknown-unknown, wasm-bindgen CLI 0.2.129; Node 26.4.0; local Google Chrome.
- Generated fixture: three seconds, 320×180, 24 fps, H.264 video and 48 kHz AAC sine audio.
  Generated with ffmpeg as an external fixture generator; nothing is linked or shipped.
- Browser: WebGPU with GPU compositor, cross-origin isolated, cooperative frame work and WebAudio.
- `cargo build -p filmcraft-web --target wasm32-unknown-unknown` passed in 4m53s.
- Browser foundation test passed all 19 gates in `foundation-v3/report.json`.
- Linked trim reduced both source video and dialogue audio by 15 frames; undo restored the complete
  inspected timeline, redo restored the edit, and history gained exactly one step.
- Saving, changing, and reopening restored the saved timeline with zero missing media. This proves
  same-page serialization; it does not verify OPFS recovery after closing or reloading the page.
- Export: 57 video frames, 555381 bytes, H.264+AAC. ffprobe reported 2.389 s container duration,
  within two frames of the 2.375 s accepted timeline. Full ffmpeg decoding completed without errors.
- The initial test expected boolean undo/redo responses; the engine returns the operation label.
  The test was corrected to require `Trim` and compare the complete timeline. No engine fix was needed.

A warmed two-second sample advanced 2.125 source seconds over 2.150 wall seconds, displayed
51 frames (23.72 frames/wall-second), and reported zero dropped frames. This is evidence for this
small synthetic fixture, not a benchmark of creator footage or a gesture latency measurement.
Do not interpret the export render throughput as real-time playback performance.

## Reproduce

Toolchain was installed under `/private/tmp/shway-rustup` and `/private/tmp/shway-cargo` without
changing the user's shell configuration. These paths are temporary; if absent, install Rust and the
exact wasm-bindgen version using [upstream setup](../web.md).

In the checkout, use a dedicated target directory:

```sh
export RUSTUP_HOME=/private/tmp/shway-rustup
export CARGO_HOME=/private/tmp/shway-cargo
export PATH="$CARGO_HOME/bin:$PATH"
export CARGO_TARGET_DIR=target/agent-foundation
cargo xtask web --dev --serve 8765
```

In another terminal with the same environment:

```sh
mkdir -p target/fixtures/shway-foundation
ffmpeg -hide_banner -loglevel error -y -f lavfi -i testsrc2=size=320x180:rate=24 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 3 -c:v libx264 -preset fast -pix_fmt yuv420p -c:a aac target/fixtures/shway-foundation/source.mp4
cp target/fixtures/shway-foundation/source.mp4 target/agent-foundation/web/dist/web-test.mp4
node apps/filmcraft-web/tests/foundation.mjs --url http://127.0.0.1:8765/ --media web-test.mp4 --out target/agent-foundation/web/foundation
```

The test writes `report.json`, screenshots, and downloaded project/export files below `--out`.
These generated artifacts stay in ignored `target/`; do not commit test media or screenshots.

## Checks run

- `cargo fmt --check`: passed.
- `cargo xtask layers`: passed.
- `cargo xtask assets`: passed, 69 assets attributed.
- `node --check apps/filmcraft-web/tests/foundation.mjs`: passed.
- Browser foundation integration and ffprobe/full ffmpeg export decoding: passed on the synthetic fixture.
- Full workspace tests, workspace clippy, full wasm gate, and real creator-media verification were not
  run for this initial baseline. Run applicable Rust gates when engine changes are integrated.

## Adapter verification

The typed browser adapter and Rust proposal boundary stage linked trim/replacement edits in a
separate engine session. They keep the accepted timeline unchanged until commit and make an
accepted proposal one undo step. Candidate preview currently provides bounded still frames.

- `node --test shway/adapter.test.ts`: 15 tests passed, including hostile inputs, coherent revision
  inspection, caller mutation, stale tokens, malformed-preview cleanup, bounded pending/dead transport, and export errors.
- Strict TypeScript compilation of `shway/adapter.ts`: passed.
- Engine proposal regression tests: 14 passed, including atomic multi-step staging, one-step undo,
  cancel/stale context, source bounds/marks, linked replacement, and pending versus failed decoders.
- Native engine full test run: 442 passed, zero failed, three existing performance benchmarks ignored.
- Native engine all-targets clippy with warnings denied: passed.
- Browser integration in `proposals-publication-final/report.json`: all 20 foundation gates passed, including
  27 proposal assertions for staging, candidate rendering, cancel, commit/undo, stale revisions,
  short-source rejection, linked replacement, and unknown/oversized requests.
- Test Chrome uses `--mute-audio`; the synthetic sine audio remains decoded and exported.

The alternative replacement was rendered and cancelled; committed replacement export in Chrome
remains open. The exported accepted project in this run contains the source-backed trim.

Generated reports and screenshots remain under ignored `target/agent-foundation/web/`.
Real creator-media acceptance remains open. The full wasm gate passed for 42 crates.
`cargo test --workspace` stopped at `filmcraft-gpu::fx_tests::gpu_effects_match_cpu_exactly`: the
extract/invert case differed from CPU by 1.33e-4 relative error with zero flipped pixels. GPU/render/color/project sources match baseline `2d2c7e6`; the focused baseline run reproduced
the identical failure. This inherited parity blocker leaves the workspace gate failed.
Final workspace all-targets clippy with warnings denied passed.
The remainder of the workspace test suite passed when explicitly excluding only
`fx_tests::gpu_effects_match_cpu_exactly`; this provides coverage, not a green full test gate.
The final muted browser run used the reviewed engine source including source-mark validation.

## Open acceptance checks

Three actual speaking takes, supporting footage, and a licensed music track have not been supplied.
Their import, audio synchronization, sustained playback, edit, save/reopen and export must be verified
before DEV-86 is complete. Event rules and the exact submission cutoff also remain unknown.

The browser path is viable for the synthetic fixture, so adapter implementation can proceed while
these checks remain explicit. Keep the native fallback available if real-media verification fails.
No gesture, speech-model, first-cut, or TRIBE capability is claimed by this test. Protected upstream
branding must be removed before distributing a modified fork; this localhost baseline is not a release.

## Related pages

[Wiki map](README.md) · [Implementation](implementation.md) · [Architecture](architecture.md) ·
[Acceptance](acceptance.md) · [Decisions](decisions.md)
