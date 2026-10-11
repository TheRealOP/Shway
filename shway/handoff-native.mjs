#!/usr/bin/env node
// TRIBE handoff from the native engine: one saved project, a speech baseline, and one accepted revision
// (timeline.remove through proposal.preview → proposal.commit = one undo step). Each state is saved,
// copied, exported (H.264/AAC) and described: project/revision/sequence ids, duration, source-to-timeline
// mapping in ticks (field names match Codex's analysis-export.mjs) and SHA-256 of the exported bytes.
//   node shway/handoff-native.mjs <source.MP4> <transcript.json> <out-dir> --cli <filmcraft-cli>
//     --ranges a0:a1,b0:b1,c0:c1 (source seconds) [--remove 1] (index of the range the revision removes)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, createReadStream, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { alignRange } from "./adapter.ts";

const TPS = 254016000000;
const [src, txFile, outDir, ...rest] = process.argv.slice(2);
const opt = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
const cli = resolve(opt("--cli") ?? "target/release/filmcraft-cli");
const secs = (opt("--ranges") ?? "").split(",").map((r) => r.split(":").map(Number));
const removeIndex = Number(opt("--remove") ?? 1);
if (!src || !txFile || !outDir || secs.some((r) => r.length !== 2 || !(r[0] >= 0 && r[1] > r[0])) || !(removeIndex >= 0 && removeIndex < secs.length)) {
  console.error("usage: handoff-native.mjs <source> <transcript.json> <out-dir> --cli <path> --ranges a:b,… [--remove i]");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const project = resolve(outDir, "handoff.fcproj");
const cmd = (...a) => JSON.parse(execFileSync(cli, ["--compact", ...a], { encoding: "utf8", maxBuffer: 1 << 28 }));
// Proposal tokens live in one process, so preview + commit run as one script.
const script = (lines, name) => {
  const f = join(outDir, name);
  writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const out = execFileSync(cli, ["--compact", "--project", project, "--save", "run", f], { encoding: "utf8", maxBuffer: 1 << 28 }).trim().split("\n").map((l) => JSON.parse(l));
  if (out.some((l) => l.ok === false || l.error)) throw new Error(`${name} failed: ${JSON.stringify(out)}`);
  return out;
};
const sha = (path) => new Promise((ok, no) => { const h = createHash("sha256"); createReadStream(path).on("data", (d) => h.update(d)).on("end", () => ok(h.digest("hex"))).on("error", no); });
const words = JSON.parse(readFileSync(txFile, "utf8")).words;

const imported = cmd("--save-as", project, "import", resolve(src));
const item = imported.items?.[0];
if (!Number.isSafeInteger(item) || imported.errors?.length) throw new Error(`import failed: ${JSON.stringify(imported)}`);
cmd("--project", project, "--save", "exec", "file.newSequence", JSON.stringify({ name: "TRIBE handoff", width: 1920, height: 1080, fps: 59.94, sampleRate: 48000 }));
let state = cmd("--project", project, "inspect", "all");
const rate = state.sequence.settings.frame_rate, seq = state.sequence.id;
const ranges = secs.map(([a, b]) => alignRange({ item, sourceIn: Math.round(a * TPS), sourceOut: Math.round(b * TPS) }, rate));
const placeRun = script([
  { id: "proposal.preview", params: { expectedRevision: state.project.revision, sequence: seq, label: "TRIBE baseline", steps: [{ command: "timeline.place", params: { ranges } }] } },
  { id: "proposal.commit", params: { token: 1 } },
], "baseline.jsonl");

// Headless runs reload the project, so in-memory revision/undo counters restart per process: identity is
// the saved project's SHA-256, and the edit evidence is the commit result from the process that made it.
async function capture(name, note, run) {
  const s = cmd("--project", project, "inspect", "all");
  copyFileSync(project, join(outDir, `${name}.fcproj`));
  const commit = run.find((l) => l.id === "proposal.commit" || l.command === "proposal.commit")?.result ?? run.at(-1)?.result ?? null;
  const mp4 = join(outDir, `${name}.mp4`);
  const t0 = Date.now();
  cmd("--project", project, "export", mp4, "--format", "h264");
  const exportSeconds = (Date.now() - t0) / 1000;
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", mp4], { encoding: "utf8" }));
  const mapping = [];
  for (const kind of ["video", "audio"]) for (const track of s.sequence[kind] ?? []) for (const c of track.items ?? []) {
    mapping.push({ kind, sourceId: String(c.item), sourceFile: basename(src), trackId: String(track.id), clipId: c.clip, link: c.link ?? null,
      sourceInTicks: c.sourceIn, sourceOutTicks: c.sourceIn + c.duration, sequenceInTicks: c.start, sequenceOutTicks: c.start + c.duration,
      words: words.filter((w) => w.start >= c.sourceIn && w.end <= c.sourceIn + c.duration).map((w) => w.text).join(" ") });
  }
  return { name, note, project: { file: `${name}.fcproj`, sha256: await sha(join(outDir, `${name}.fcproj`)), commit,
    revisionNote: "headless revision counters restart on each load; use sha256 + commit for identity" }, sequence: { id: s.sequence.id,
    durationTicks: s.sequence.duration, durationSeconds: s.sequence.duration / TPS, frameRate: s.sequence.settings.frame_rate },
    mapping, export: { file: `${name}.mp4`, sha256: await sha(mp4), bytes: statSync(mp4).size, exportSeconds,
      probe: { durationSeconds: Number(probe.format.duration), streams: probe.streams.map((x) => ({ type: x.codec_type, codec: x.codec_name,
        frames: Number(x.nb_read_frames) || null, width: x.width ?? null, height: x.height ?? null, sampleRate: x.sample_rate ?? null })) } } };
}

const baseline = await capture("baseline", "Three ranges of continuous speech placed by one committed proposal.", placeRun);
const victim = cmd("--project", project, "inspect", "sequence").video[0].items[removeIndex];
state = cmd("--project", project, "inspect", "all");
const removeRun = script([
  { id: "proposal.preview", params: { expectedRevision: state.project.revision, sequence: seq, label: `Remove range ${removeIndex + 1}`, steps: [{ command: "timeline.remove", params: { clips: [victim.clip] } }] } },
  { id: "proposal.commit", params: { token: 1 } },
], "revision.jsonl");
const revision = await capture("revision", `Baseline with range ${removeIndex + 1} (clip ${victim.clip} and its linked audio) ripple-removed by one accepted proposal.`, removeRun);
const manifest = { version: 1, createdAt: new Date().toISOString(), ticksPerSecond: TPS, engine: "filmcraft-cli (native, headless)",
  source: { file: basename(src), sha256: await sha(src), transcript: basename(txFile) }, renders: [baseline, revision] };
writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ outDir, baseline: [baseline.sequence.durationSeconds, baseline.export.sha256], revision: [revision.sequence.durationSeconds, revision.export.sha256] }));
