#!/usr/bin/env node
// Long-form first cut from word-timed transcripts (transcribe-local.mjs output), planned by Gemini
// through the local proxy (segment numbers + text only, never times) and assembled in the engine
// as one proposal.preview → proposal.commit. Node ≥ 23 (imports adapter.ts for alignRange).
//
//   node shway/longform.mjs segments <tx-dir> <segments.json> [--media <clip dir>]   (numbered in recording order)
//   node shway/longform.mjs plan <segments.json> <clips.json> <plan.json> [--url http://127.0.0.1:8792]
//   node shway/longform.mjs assemble <segments.json> <plan.json> <media-dir> <out.fcproj> <cut.json> [--cli path]
//   node shway/longform.mjs compare <cut.json> <export-transcript.json>
//
// clips.json: {"C5500": "one-line description", ...}. cut.json: the placed ranges, for EDL/compare.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { alignRange } from "./adapter.ts";

const TPS = 254016000000;
const GAP = 0.7 * TPS, MAX_LEN = 15 * TPS, PAD_IN = 0.2 * TPS, PAD_OUT = 0.3 * TPS;
const MAX_RANGES = 32; // engine proposals.rs MAX_TARGETS
const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);

/** Split one transcript into segments at pauses ≥ GAP, sentence ends, or MAX_LEN. Word-exact ticks. */
export function segment(clip, words) {
  const out = [];
  let cur = [];
  const flush = () => { if (cur.length) out.push({ clip, start: cur[0].start, end: cur.at(-1).end, text: cur.map((w) => w.text).join(" ") }); cur = []; };
  for (const w of words) {
    const last = cur.at(-1);
    if (last && (w.start - last.end >= GAP || w.start - cur[0].start >= MAX_LEN || (/[.?!]$/.test(last.text) && last.end - cur[0].start >= 3 * TPS))) flush();
    cur.push(w);
  }
  flush();
  return out;
}

/** A clip's media file: <clip>.MP4 (Sony) or <clip>.MOV (iPhone). */
export const mediaFile = (mediaDir, clip) => resolve(mediaDir, readdirSync(mediaDir).find((f) => /\.(mp4|mov)$/i.test(f) && basename(f).replace(/\.\w+$/, "") === clip) ?? `${clip}.MP4`);

/**
 * When the camera recorded a clip, in ms; null if unknown: Sony's <clip>M01.XML sidecar CreationDate,
 * else the QuickTime creation date (iPhone). Segments are numbered in this order, so segment numbers ARE the chronology.
 */
export function recordedAt(mediaDir, clip) {
  let date = null;
  try { date = /CreationDate value="([^"]+)"/.exec(readFileSync(join(mediaDir, `${clip}M01.XML`), "utf8"))?.[1]; } catch {}
  if (!date) try {
    const tags = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format_tags", "-of", "json", mediaFile(mediaDir, clip)], { encoding: "utf8" })).format?.tags ?? {};
    date = tags["com.apple.quicktime.creationdate"] ?? tags.creation_time;
  } catch {}
  const t = date ? Date.parse(date) : NaN;
  return Number.isFinite(t) ? t : null;
}
/** Clips by recording time; clips without a time keep file-name order after the timed ones. */
export function chronological(clips, timeOf) {
  return [...clips].sort((a, b) => (timeOf(a) ?? Infinity) - (timeOf(b) ?? Infinity) || a.localeCompare(b));
}

/** Every number exists, appears once, in increasing (recording) order, total words in budget; an error string or null. */
export function validatePlan(plan, segments, words = [500, 2000]) {
  const count = segments.length;
  if (!plan || typeof plan.title !== "string" || !plan.title.trim() || !Array.isArray(plan.sections) || !plan.sections.length) return "need a title and a non-empty sections array";
  const seen = new Set();
  let prev = 0;
  for (const s of plan.sections) {
    if (!s || typeof s.name !== "string" || !Array.isArray(s.segments) || !s.segments.length) return "every section needs a name and at least one segment";
    for (const x of s.segments) {
      if (!Number.isInteger(x?.n) || x.n < 1 || x.n > count) return `segment ${JSON.stringify(x?.n)} does not exist (valid: 1–${count})`;
      if (seen.has(x.n)) return `segment ${x.n} is used twice`;
      if (x.n < prev) return `segment ${x.n} comes after ${prev}; the video must follow recording order (increasing numbers)`;
      seen.add(x.n); prev = x.n;
    }
  }
  const total = [...seen].reduce((n, i) => n + wordCount(segments[i - 1].text), 0);
  if (total < words[0] || total > words[1]) return `the selection has ${total} spoken words; it must have ${words[0]}–${words[1]}`;
  return null;
}
const wordCount = (t) => t.split(/\s+/).filter(Boolean).length;

/** Playlist → source ranges: pad into the surrounding silence, merge consecutive numbers. */
export function toRanges(plan, segments) {
  // Recording order is enforced here, whatever order the plan listed: numbers are chronological.
  const list = plan.sections.flatMap((s) => s.segments.map((x) => ({ ...x, section: s.name }))).sort((a, b) => a.n - b.n);
  const ranges = [];
  for (const x of list) {
    const seg = segments[x.n - 1], prev = segments[x.n - 2], next = segments[x.n];
    const lo = prev?.clip === seg.clip ? prev.end : 0, hi = next?.clip === seg.clip ? next.start : Infinity;
    const r = { clip: seg.clip, sourceIn: Math.max(lo, seg.start - PAD_IN, 0), sourceOut: Math.min(hi, seg.end + PAD_OUT), segs: [{ n: x.n, reason: x.reason, text: seg.text, section: x.section }] };
    const last = ranges.at(-1);
    if (last && last.clip === r.clip && last.segs.at(-1).n === x.n - 1) { last.sourceOut = r.sourceOut; last.segs.push(...r.segs); } else ranges.push(r);
  }
  return ranges;
}

async function plan(segFile, clipsFile, outFile, url) {
  const segments = readJson(segFile), clips = readJson(clipsFile);
  const system = "You are a YouTube editor. You only choose from numbered transcript segments; you never invent numbers.";
  const prompt = [
    "Footage: a vlog of a group of friends at the ShellHacks hackathon (Miami), filmed by one of them.",
    "Segments are numbered in the order they were recorded, and the video plays them strictly in that order.",
    "Clip descriptions:", ...Object.entries(clips).map(([c, d]) => `${c}: ${d}`),
    "", "Numbered transcript segments (automatic Whisper transcript, may contain errors):",
    ...segments.map((s, i) => `[${i + 1}] (${s.clip}, ${wordCount(s.text)}w) ${s.text}`),
    "", "Build a horizontal long-form YouTube video that tells the weekend as it happened: choose which segments to keep and group them into chronological sections (start, build, setbacks, finish).",
    "List segment numbers in increasing order only; never move a later moment earlier. Prefer runs of consecutive numbers so lines are not chopped mid-thought; skip filler, mumbling and unintelligible lines.",
    "Let the content decide the length within 600–1900 spoken words in total (about 4–13 minutes); add up the word counts shown as (Nw). Give a short reason per segment, a working title, and a one-sentence explanation of the chosen length.",
  ].join("\n");
  const schema = {
    type: "object", required: ["title", "lengthReason", "sections"], properties: {
      title: { type: "string" }, lengthReason: { type: "string" },
      sections: { type: "array", items: { type: "object", required: ["name", "segments"], properties: {
        name: { type: "string" },
        segments: { type: "array", items: { type: "object", required: ["n", "reason"], properties: { n: { type: "integer" }, reason: { type: "string" } } } },
      } } },
    },
  };
  const ask = async (p) => {
    const r = await fetch(`${url}/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: p, system, schema }) });
    const body = await r.json();
    if (!r.ok) throw new Error(`gemini proxy ${r.status}: ${body.error}`);
    return body.json;
  };
  const t0 = Date.now();
  let result = await ask(prompt), error = validatePlan(result, segments), attempts = 1;
  if (error) {
    process.stderr.write(`plan invalid (${error}); retrying once\n`);
    result = await ask(`${prompt}\n\nYour previous answer was rejected: ${error}. Answer again using only existing segment numbers, each at most once, in increasing order, within the word budget.`);
    error = validatePlan(result, segments);
    attempts = 2;
  }
  if (error) throw new Error(`plan invalid after retry: ${error}`);
  writeFileSync(outFile, JSON.stringify({ ...result, attempts, seconds: (Date.now() - t0) / 1000 }, null, 1));
  process.stderr.write(`plan ok in ${(Date.now() - t0) / 1000}s (${attempts} attempt(s))\n`);
}

function assemble(segFile, planFile, mediaDir, project, cutFile, cliPath) {
  const run = (...a) => JSON.parse(execFileSync(cliPath, ["--compact", ...a], { encoding: "utf8", maxBuffer: 1 << 28 }));
  const t0 = Date.now();
  const ranges = toRanges(readJson(planFile), readJson(segFile));
  const clips = [...new Set(ranges.map((r) => r.clip))].sort();
  const imported = run("--save-as", project, "import", ...clips.map((c) => mediaFile(mediaDir, c)));
  if (imported.errors?.length || imported.items?.length !== clips.length) throw new Error(`import failed: ${JSON.stringify(imported)}`);
  const item = Object.fromEntries(clips.map((c, i) => [c, imported.items[i]]));
  run("--project", project, "--save", "exec", "file.newSequence", JSON.stringify({ name: "Long-form cut", width: 1920, height: 1080, fps: 59.94, sampleRate: 48000 }));
  const inspected = run("--project", project, "inspect", "all");
  const rate = inspected.sequence.settings.frame_rate, seq = inspected.sequence.id, revision = inspected.project.revision;
  const [num, den, tps] = [BigInt(rate.num), BigInt(rate.den), BigInt(TPS)];
  const placed = ranges.map((r) => {
    const dur = BigInt(run("probe", mediaFile(mediaDir, r.clip)).duration);
    const a = alignRange({ item: item[r.clip], sourceIn: Math.round(r.sourceIn), sourceOut: Math.round(Math.min(r.sourceOut, Number(dur))) }, rate);
    // Widening may pass the source end: clamp to its last whole frame (same ceil tick-of-frame as alignRange).
    const last = (dur * num / (tps * den) * tps * den + num - 1n) / num;
    if (BigInt(a.sourceOut) > dur) a.sourceOut = Number(last);
    return { ...r, ...a };
  });
  const chunks = [];
  for (let i = 0; i < placed.length; i += MAX_RANGES) chunks.push(placed.slice(i, i + MAX_RANGES));
  // Tokens count from 1 per process and the revision rises by one per commit.
  const script = chunks.flatMap((c, i) => [
    { id: "proposal.preview", params: { expectedRevision: revision + i, sequence: seq, label: chunks.length > 1 ? `Long-form cut ${i + 1}/${chunks.length}` : "Long-form cut", steps: [{ command: "timeline.place", params: { ranges: c.map(({ item, sourceIn, sourceOut }) => ({ item, sourceIn, sourceOut })) } }] } },
    { id: "proposal.commit", params: { token: i + 1 } },
  ]);
  const scriptFile = cutFile.replace(/\.json$/, ".jsonl");
  writeFileSync(scriptFile, script.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const lines = execFileSync(cliPath, ["--compact", "--project", project, "--save", "run", scriptFile], { encoding: "utf8", maxBuffer: 1 << 28 }).trim().split("\n").map((l) => JSON.parse(l));
  const results = lines.filter((l) => l.id === "proposal.preview").flatMap((l) => l.result.results.flatMap((r) => r.placed));
  if (results.length !== placed.length) throw new Error(`placed ${results.length} of ${placed.length} ranges`);
  placed.forEach((p, i) => { p.start = results[i].start; if (results[i].sourceIn !== p.sourceIn || results[i].sourceOut !== p.sourceOut) throw new Error(`range ${i} moved`); });
  const after = run("--project", project, "inspect", "sequence");
  writeFileSync(cutFile, JSON.stringify({ project: resolve(project), sequence: seq, proposals: chunks.length, commits: lines.filter((l) => l.id === "proposal.commit").map((l) => l.result), durationTicks: after.duration, durationFrames: after.durationFrames, seconds: (Date.now() - t0) / 1000, ranges: placed }, null, 1));
  process.stderr.write(`assembled ${placed.length} ranges in ${chunks.length} proposal(s), ${(after.duration / TPS).toFixed(2)} s, ${(Date.now() - t0) / 1000}s\n`);
}

/** LCS word overlap, overall and per range, of the planned text vs a re-transcription of the export. */
export function overlap(a, b) {
  const x = norm(a), y = norm(b);
  if (!x.length) return 1;
  let prev = new Array(y.length + 1).fill(0);
  for (const w of x) {
    const cur = [0];
    for (let j = 1; j <= y.length; j++) cur[j] = w === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return prev[y.length] / x.length;
}

function compare(cutFile, txFile) {
  const cut = readJson(cutFile), words = readJson(txFile).words;
  const rows = cut.ranges.map((r, i) => {
    const end = r.start + (r.sourceOut - r.sourceIn);
    const heard = words.filter((w) => w.start >= r.start - 0.5 * TPS && w.start < end).map((w) => w.text).join(" ");
    return { i: i + 1, clip: r.clip, recall: +overlap(r.segs.map((s) => s.text).join(" "), heard).toFixed(2) };
  });
  const all = overlap(cut.ranges.flatMap((r) => r.segs.map((s) => s.text)).join(" "), words.map((w) => w.text).join(" "));
  console.log(JSON.stringify({ overallRecall: +all.toFixed(3), plannedWords: norm(cut.ranges.flatMap((r) => r.segs.map((s) => s.text)).join(" ")).length, heardWords: words.length, low: rows.filter((r) => r.recall < 0.6), rows }, null, 1));
}

function selfTest() {
  const w = (t, s, e) => ({ text: t, start: s * TPS, end: e * TPS });
  const segs = segment("C1", [w("a", 0, 1), w("b.", 1, 4), w("c", 4.1, 5), w("d", 6, 7)]);
  if (segs.length !== 3 || segs[0].text !== "a b." || segs[2].start !== 6 * TPS) throw new Error("segment");
  if (validatePlan({ title: "t", sections: [{ name: "x", segments: [{ n: 1 }, { n: 1 }] }] }, segs, [0, 9]) !== "segment 1 is used twice") throw new Error("dup");
  if (!validatePlan({ title: "t", sections: [{ name: "x", segments: [{ n: 4 }] }] }, segs, [0, 9])?.includes("does not exist")) throw new Error("range");
  if (!validatePlan({ title: "t", sections: [{ name: "x", segments: [{ n: 1 }] }] }, segs, [3, 9])?.includes("2 spoken words")) throw new Error("budget");
  if (!validatePlan({ title: "t", sections: [{ name: "x", segments: [{ n: 3 }] }, { name: "y", segments: [{ n: 1 }] }] }, segs, [0, 9])?.includes("recording order")) throw new Error("order");
  const r = toRanges({ sections: [{ name: "x", segments: [{ n: 3 }, { n: 1 }, { n: 2 }] }] }, segs); // listed out of order: placed chronologically
  if (r.length !== 1 || r[0].segs.map((x) => x.n).join() !== "1,2,3" || r[0].sourceIn !== 0 || r[0].sourceOut !== segs[2].end + PAD_OUT) throw new Error("ranges");
  const t = { B: 2, A: 3, C: null, D: 1 };
  if (chronological(["A", "B", "C", "D"], (c) => t[c]).join("") !== "DBAC") throw new Error("chronological");
  if (overlap("the cat sat", "a cat sat down") !== 2 / 3) throw new Error("overlap");
  console.log("self-test ok");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...a] = process.argv.slice(2);
  const opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a.splice(i, 2)[1] : d; };
  try {
    if (cmd === "segments") {
      const media = opt("--media", null);
      const time = (c) => (media ? recordedAt(media, c) : null);
      const clips = chronological(readdirSync(a[0]).filter((f) => /^(C|IMG_)\d+\.json$/.test(f)).map((f) => basename(f, ".json")), time);
      const segs = clips.flatMap((c) => segment(c, readJson(join(a[0], `${c}.json`)).words).map((s) => ({ ...s, recordedAt: time(c) == null ? null : new Date(time(c)).toISOString() })));
      writeFileSync(a[1], JSON.stringify(segs, null, 1));
      process.stderr.write(`${segs.length} segments from ${clips.length} clips (${clips.filter((c) => time(c) != null).length} with recording times)\n`);
    } else if (cmd === "plan") { const url = opt("--url", "http://127.0.0.1:8792"); await plan(a[0], a[1], a[2], url); }
    else if (cmd === "assemble") { const cli = opt("--cli", "target/release/filmcraft-cli"); assemble(a[0], a[1], a[2], a[3], a[4], resolve(cli)); }
    else if (cmd === "compare") compare(a[0], a[1]);
    else if (cmd === "test") selfTest();
    else throw new Error("usage: longform.mjs segments|plan|assemble|compare|test …");
  } catch (e) { process.stderr.write(`longform: ${e.message}\n`); process.exit(1); }
}
