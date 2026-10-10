#!/usr/bin/env node
// Local word-timed transcript for one media file via FilmCraft's built-in Whisper (headless
// filmcraft-cli built with `--features whisper`). Writes a TranscriptInput (shway/takes.ts).
//
//   node shway/transcribe-local.mjs <media> [--out t.json] [--source-item N] [--model whisper-base]
//        [--language en|auto] [--download] [--cli target/release/filmcraft-cli]
//
// --download fetches the model (size/licence: `filmcraft-cli exec transcript.models`) into the
// FilmCraft data dir ($FILMCRAFT_DATA_DIR or ~/Library/Application Support/FilmCraft) first.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_WORDS = 20000, MAX_WORD_LENGTH = 100;

// Engine transcript (`project.transcripts[id]`, Tick = 1/254016000000 s) → TranscriptInput.
// Blank words are dropped; anything else malformed throws (never guess cut points).
export function toTranscriptInput(transcript, sourceItemId) {
  if (!Number.isSafeInteger(sourceItemId) || sourceItemId < 1) throw new Error("sourceItemId must be an integer >= 1");
  if (!transcript || typeof transcript !== "object" || !Array.isArray(transcript.words)) throw new Error("engine transcript has no words array");
  let previousEnd = 0;
  const words = [];
  for (const [i, w] of transcript.words.entries()) {
    if (!w || typeof w !== "object") throw new Error(`word ${i} is not an object`);
    const text = typeof w.text === "string" ? w.text.trim() : "";
    if (!text) continue;
    if (text.length > MAX_WORD_LENGTH) throw new Error(`word ${i} is longer than ${MAX_WORD_LENGTH} characters`);
    const { start, end } = w;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) throw new Error(`word ${i} has invalid tick bounds`);
    if (start < previousEnd) throw new Error(`word ${i} overlaps the previous word`);
    previousEnd = end;
    const out = { text, start, end };
    // The engine omits confidence when it is 1.
    if (typeof w.confidence === "number" && Number.isFinite(w.confidence) && w.confidence >= 0 && w.confidence < 1) out.confidence = w.confidence;
    words.push(out);
  }
  if (words.length === 0) throw new Error("no words were recognised");
  if (words.length > MAX_WORDS) throw new Error(`more than ${MAX_WORDS} words`);
  const language = typeof transcript.language === "string" && /^[a-z]{2,3}$/.test(transcript.language) ? transcript.language : undefined;
  return { sourceItemId, timeUnit: "ticks", ...(language && { language }), words };
}

function args(argv) {
  const o = { cli: "target/release/filmcraft-cli", model: "whisper-base", language: "auto" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--download") o.download = true;
    else if (["--out", "--source-item", "--model", "--language", "--cli"].includes(a)) {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      o[a.slice(2).replace("-item", "Item")] = argv[++i];
    } else if (!o.media && !a.startsWith("--")) o.media = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!o.media) throw new Error("usage: transcribe-local.mjs <media> [--out f] [--source-item N] [--model id] [--language l] [--download] [--cli path]");
  return o;
}

function main() {
  const o = args(process.argv.slice(2));
  const cli = (...a) => JSON.parse(execFileSync(resolve(o.cli), a, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 256 << 20 }));
  if (o.download) cli("exec", "transcript.downloadModel", `model=${o.model}`);
  const dir = mkdtempSync(join(tmpdir(), "shway-transcribe-"));
  try {
    const project = join(dir, "t.fcproj");
    const imported = cli("--save-as", project, "import", resolve(o.media));
    const id = imported?.items?.[0];
    if (!Number.isSafeInteger(id)) throw new Error(`import failed: ${JSON.stringify(imported?.errors ?? imported)}`);
    const t0 = Date.now();
    const gen = cli("--project", project, "--save", "exec", "transcript.generate", JSON.stringify({ items: [id], model: o.model, language: o.language, diarize: false }));
    process.stderr.write(`transcribed in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${JSON.stringify(gen)}\n`);
    const saved = JSON.parse(readFileSync(project, "utf8"));
    const input = toTranscriptInput(saved?.project?.transcripts?.[String(id)], o.sourceItem === undefined ? id : Number(o.sourceItem));
    const text = JSON.stringify(input, null, 1) + "\n";
    if (o.out) writeFileSync(o.out, text); else process.stdout.write(text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { process.stderr.write(`transcribe-local: ${e.message}\n`); process.exit(1); }
}
