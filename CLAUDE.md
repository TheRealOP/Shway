# Shway — working instructions for agents

FilmCraft is a clean-room, open-source, pure-Rust non-linear video editor targeting Adobe Premiere Pro parity (and beyond). Native on macOS, Windows, Linux; web via WASM. Sibling of `../photocraft` (Photoshop), `../pdfcraft` (Acrobat) and `../vectorcraft` (Illustrator; formerly DrawCraft), with the same conventions.

## Start every session here

1. Read [AGENTS.md](AGENTS.md); its rules take precedence here.
2. Start at the [Shway knowledge graph](docs/wiki/README.md).
   Read [Product](docs/wiki/product.md), the current [Implementation gate](docs/wiki/implementation.md),
   and the relevant subsystem page and source.
3. Apply [YAGNI](docs/wiki/yagni.md). Use the exact Ponytail skill only if its SKILL.md is actually
   available and read; otherwise YAGNI is sufficient.
4. Read the task's Linear acceptance criteria. Implement the smallest complete behavior,
   verify actual edit/export behavior where relevant, and update linked wiki decisions/contracts.
5. Use upstream [architecture](docs/architecture.md), [contributing](docs/contributing.md),
   and [testing](docs/testing.md) documentation for the Rust base.
   Maintainer-local plan/ files are optional references, not the Shway task roadmap.

Shway adds an explicitly permitted TypeScript interaction surface and a separate Python inference
worker. The editor engine remains Rust. For documentation-only changes, use link/graph/diff checks
as specified in AGENTS.md; for runtime changes, run applicable upstream gates and integration checks.
Keep reported status honest: planned versus verified, with evidence.

## Non-negotiables
**Read [`AGENTS.md`](AGENTS.md) first; its rules override everything here.**
- **Never crash** ([`AGENTS.md`](AGENTS.md) §0, standard: [`craftrules/standards/never-crash.md`](https://github.com/storytold/craftrules/blob/main/standards/never-crash.md)). People depend on FilmCraft; a crash loses their work, so this outranks feature work. No `unwrap`/`expect`/`panic!`/`unreachable!`/`todo!`/`unimplemented!` or `unsafe` outside tests: return `Result<T, E>` and propagate with `?` (`ok_or`, `let … else`, `if let`). Treat every number from media, project files, presets or CLI/MCP/control params as hostile: `get()` instead of `[i]`, checked/saturating math, no division by possibly-zero values, capped allocations, bounded recursion. `lock().unwrap_or_else(PoisonError::into_inner)`; background jobs run under `catch_unwind`. The panic hook + UI `catch_unwind` (`crates/ui-egui/src/crash.rs`) are the last-resort guard, not a licence. Every crash fix gets a regression test that panicked before. In particular (§1): never use Adobe iconography, images or any other Adobe asset. Every asset must be openly licensed (OSS / public domain / Creative Commons, or original work by a contributor) and must have a `<file>.attribution` sidecar plus an entry in `ATTRIBUTION.md`. `cargo xtask assets` enforces this.
- **Fonts** live in [storytold/craft-fonts](https://github.com/storytold/craft-fonts), never in this repo (no new font files here; [`AGENTS.md`](AGENTS.md) §1.9, standard: [`craftrules/standards/fonts.md`](https://github.com/storytold/craftrules/blob/main/standards/fonts.md)). Build with them: `git clone https://github.com/storytold/craft-fonts ../craft-fonts && CRAFT_FONTS_DIR="$PWD/../craft-fonts" cargo run -p filmcraft` (`crates/text/build.rs` embeds them as `filmcraft_text::fonts::CRAFT_FONTS`, used for Japanese in the UI and titles). Unset, `CRAFT_FONTS` is empty and everything must still build, test and run; never add craft-fonts to a `Cargo.toml`. Tests on its glyphs skip when it is empty, so run the gates with and without `CRAFT_FONTS_DIR` when you touch fonts.
- **Clean-room.** Never read/disassemble anything inside Adobe app bundles (names/listings only). Never copy Adobe icons, presets, LUTs, fonts. Never copy GPL/LGPL/AGPL code (FFmpeg, x264, x265, MLT, Kdenlive, Shotcut, Olive, LAME…). ffmpeg/ffprobe run only as external test oracles / fixture generators — never linked or shipped.
- **Pure Rust** in the editor engine (Shway's interaction surface and separate research worker follow the scope in AGENTS.md). OS media APIs only via Rust bindings in `crates/platform` (hardware decoding; the one crate allowed `unsafe`, see `AGENTS.md` §0.3 and `docs/adr/0001-platform-ffi.md`), optional, behind traits, with our decoders as the fallback.
- **Layering** ([`docs/architecture.md`](docs/architecture.md) §1, enforced by `cargo xtask layers`): nothing below L5 depends on egui/eframe/winit/rfd/cpal. L0 codec/container crates depend only on `filmcraft-bitstream`.
- **Exact time:** all time is `filmcraft_time::Tick` (254 016 000 000/s). Never use f64 seconds for edit math.
- **Everything is a command** (`crates/engine`): id, label, menu path, shortcut, params, enabled(), run(). UI, CLI, control channel and MCP all dispatch by id.
- **Everything is agent-drivable:** every interactive widget registers an automation id; UI state is serde so the control channel can read/set it.
- **Quality gates** before every commit: `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`, `cargo xtask layers`, `cargo xtask assets`, `cargo xtask wasm` (checks L0–L4 crates). `cargo xtask ci` runs them all.
- **Commits:** one task id per commit (`M2.4: CABAC residual decoding`). Only green states. End messages with the attribution line required by the environment.

## Running and looking at the app
- `cargo run -p filmcraft -- --control 9876` opens the desktop app with the JSON-lines control server (see `docs/control-protocol.md`).
- For UI work, **look at the result**: drive via the control channel and take `ui.screenshot`, compare with `plan/premiere/screenshots/` (maintainer-local; see [`docs/agents.md`](docs/agents.md) §3).
- Parallel agents: separate git worktrees and `CARGO_TARGET_DIR=target/agent-<name>`; keep every `Cargo.toml` valid at all times (the `crates/*` glob means one broken manifest breaks everyone).
- Test fixtures: generate with ffmpeg into `target/fixtures/` (never commit media). See [`docs/testing.md`](docs/testing.md).
