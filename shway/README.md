# Shway browser adapter

`adapter.ts` is a narrow typed boundary over the running `window.filmcraft` engine. Rust keeps the
project, exact edit time, rendering, and undo history. No second timeline is maintained here.

Requires Node 26 for the dependency-free TypeScript-to-browser module build:

```sh
node --test shway/adapter.test.ts
node shway/build.mjs --out target/agent-foundation/web/dist
```

Build the editor first using [web setup](../docs/web.md); `cargo xtask web` recreates the distribution
directory, so generate `adapter.js` afterward. Load the emitted module from the same localhost origin:

```js
const { ShwayAdapter } = await import('/adapter.js');
const adapter = await ShwayAdapter.connect(window.filmcraft);
const { project, sequence } = await adapter.inspect();
```

Connection discovers command IDs and rejects engines that lack the proposal boundary. The registry
contains human-readable parameter descriptions; it is not itself a strict JSON schema. This adapter
and Rust's typed deserializer validate the allowlisted proposal shape.

The supported proposal steps are `timeline.trim`, `clip.replaceFromBin` and `timeline.place`. Proposals explicitly name
expected revision, active sequence, target clips, source IDs, and frame deltas. Requests are limited
to 16 steps, 32 total explicit target references, and labels of at most 120 UTF-8 bytes. Rust stages them in a
disposable session. `previewFrame` returns bounded RGBA pixels from that candidate without changing
the authoritative timeline. Explicit pending media responses retry for at most five seconds. Real
source/decode failures, stale revisions and changed interaction context remain actionable errors.

`assemble({expectedRevision, sequence, label, ranges})` builds a first cut: one `timeline.place`
step appending `ranges: [{item, sourceIn, sourceOut}]` (source ticks) in order on V1 with linked
audio on A1, after the active sequence's existing content. Ranges must lie on the sequence frame
grid; `alignRange(range, sequence.settings.frame_rate)` widens word-boundary ticks explicitly
(In down, Out up) with exact integer math. Make or activate an empty sequence first for a clean cut.

```js
const rate = sequence.settings.frame_rate;
const ranges = takes.map(t => alignRange({item: t.item, sourceIn: t.sourceIn, sourceOut: t.sourceOut}, rate));
const preview = await adapter.assemble({expectedRevision: project.revision, sequence: sequence.id, label: 'First cut', ranges});
await adapter.commit(preview.token); // one undo step; or adapter.cancel(preview.token)
```

`commit` makes one normal undoable edit; `cancel` discards the candidate. Seek and normal controls
remain available. A newer edit is preserved when a stale proposal is rejected or discarded.

The adapter also exposes `select`, `seekFrame`, `play`, `stop`, `undo`, H.264/AAC `export`, and `jobs`.
There is no public arbitrary model-command passthrough. Playback and export operate on the accepted
project; staged candidates are inspected/rendered through their token.

Current limitations: finite media sources, synchronized linked A/V, normal speed, no reverse, frame
hold, multicamera, nested sequence or subclip targets. Proposals whose exact trim exceeds handles or
whose replacement is shorter than the retained clip are rejected for replanning. A candidate frame
API is available; no full gesture/voice interface or real-time candidate playback is claimed.

Run the real browser integration with generated source, alternative and short fixtures served next
to the editor's index:

```sh
ffmpeg -hide_banner -loglevel error -y -f lavfi -i color=c=purple:size=320x180:rate=24 -f lavfi -i sine=frequency=880:sample_rate=48000 -t 4 -c:v libx264 -preset fast -pix_fmt yuv420p -c:a aac target/agent-foundation/web/dist/alternative.mp4
ffmpeg -hide_banner -loglevel error -y -f lavfi -i color=c=green:size=320x180:rate=24 -f lavfi -i sine=frequency=220:sample_rate=48000 -t 1 -c:v libx264 -preset fast -pix_fmt yuv420p -c:a aac target/agent-foundation/web/dist/short.mp4
node apps/filmcraft-web/tests/foundation.mjs --url http://127.0.0.1:8765/ --media web-test.mp4 --out target/agent-foundation/web/proposals --proposals
```

See [foundation evidence](../docs/wiki/foundation-evidence.md) and the
[architecture contract](../docs/wiki/architecture.md). Never commit fixtures or generated output.
