// TRIBE handoff (DEV-97 step 2): a ~15 s spoken baseline and one deliberate edit of it, both exported
// from the same authoritative project, with exact ids, revisions, tick ranges and export SHA-256.
// Called by foundation.mjs --handoff; needs adapter.js, takes.js, replace.js and the proxy.
import {readFileSync, writeFileSync, mkdirSync, copyFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {join, basename} from "node:path";

const T = 254016000000;

export function buildBaseline({evaluate, item, transcriptPath}) {
  const transcript = JSON.parse(readFileSync(transcriptPath, "utf8"));
  return evaluate(`(${baselineScenario.toString()})(${JSON.stringify({item, transcript})})`, 120000);
}

export function editBaseline({evaluate, proxy, decider}) {
  return evaluate(`(${editScenario.toString()})(${JSON.stringify({proxy, decider})})`, 120000);
}

// Every take of the source, in source order, padded by 0.25 s, as one "TRIBE baseline" placement.
async function baselineScenario({item, transcript}) {
  const {ShwayAdapter, alignRange} = await import('/adapter.js');
  const {parseTranscript, indexTakes} = await import('/takes.js');
  const adapter = await ShwayAdapter.connect(window.filmcraft);
  await filmcraft.execute('file.newSequence', {name: 'TRIBE baseline'});
  const source = parseTranscript({...transcript, sourceItemId: item});
  await adapter.importTranscript({...transcript, sourceItemId: item});
  window.shwayHandoff = {takes: indexTakes([source], ['Welcome to the workshop.', 'Today we build a gesture editor.'])};
  const {project, sequence} = await adapter.inspect();
  const pad = 254016000000 / 4;
  const ranges = [...window.shwayHandoff.takes].sort((a, b) => a.sourceIn - b.sourceIn)
    .map(t => alignRange({item, sourceIn: Math.max(0, t.sourceIn - pad), sourceOut: t.sourceOut + pad}, sequence.settings.frame_rate));
  const preview = await adapter.assemble({expectedRevision: project.revision, sequence: sequence.id, label: 'TRIBE baseline', ranges});
  await adapter.commit(preview.token);
  const after = await adapter.inspect();
  const history = (await filmcraft.execute('history.list')).undo;
  const ok = after.sequence.video[0].items.length === 6 && history.at(-1) === 'TRIBE baseline';
  return {ok, project: after.project, sequence: after.sequence, history};
}

// The deliberate edit: replace the "uh" take of line 1 (third clip) with the "our workshop" take.
async function editScenario({proxy, decider}) {
  const {ShwayAdapter} = await import('/adapter.js');
  const {proposeReplacement, geminiGenerate, jevDecide} = await import('/replace.js');
  const adapter = await ShwayAdapter.connect(window.filmcraft);
  const {project, sequence} = await adapter.inspect();
  const clip = sequence.video[0].items[2];
  await adapter.select([clip.clip]);
  const r = await proposeReplacement({transcript: 'Use the take where I say "our workshop" instead.', takes: window.shwayHandoff.takes,
    context: {revision: project.revision, sequence: sequence.id, selection: [clip.clip]}, adapter,
    generate: geminiGenerate(proxy), decide: decider === 'jev' ? jevDecide(proxy) : undefined});
  if (r.status !== 'preview') return {ok: false, result: r};
  await adapter.commit(r.token);
  const after = await adapter.inspect();
  const history = (await filmcraft.execute('history.list')).undo;
  const words = t => t.words.map(w => w.text).join(' ');
  return {ok: history.at(-1) === r.label && /\bour\b/.test(words(r.take)), project: after.project, sequence: after.sequence, history,
    edit: {clip: clip.clip, label: r.label, from: words(r.from), to: words(r.take), decider, explanation: r.explanation, steps: r.proposal.steps}};
}

/** Writes manifest.json plus both exports to `dir`; returns the manifest. */
export function writeHandoff({dir, mediaPath, transcriptPath, baseline, edited}) {
  mkdirSync(dir, {recursive: true});
  const words = JSON.parse(readFileSync(transcriptPath, "utf8")).words;
  const sha = path => createHash("sha256").update(readFileSync(path)).digest("hex");
  const clips = sequence => [...sequence.video.map((t, i) => [`V${i + 1}`, t]), ...sequence.audio.map((t, i) => [`A${i + 1}`, t])]
    .flatMap(([track, t]) => t.items.map(c => ({track, clip: c.clip, item: c.item, link: c.link ?? null, start: c.start, duration: c.duration,
      sourceIn: c.sourceIn, sourceOut: c.sourceIn + c.duration,
      words: words.filter(w => w.start >= c.sourceIn && w.end <= c.sourceIn + c.duration).map(w => w.text).join(" ")})));
  const render = (name, step, exp) => {
    const file = `${name}.mp4`;
    copyFileSync(exp.download.path, join(dir, file));
    const video = exp.probe.streams.find(s => s.codec_type === "video");
    return {name, file, sha256: exp.download.sha256, bytes: exp.download.bytes,
      project: {revision: step.project.revision}, sequence: {id: step.sequence.id, duration: step.sequence.duration,
        durationSeconds: step.sequence.duration / T, frameRate: step.sequence.settings.frame_rate, clips: clips(step.sequence)},
      history: step.history, probe: {durationSeconds: Number(exp.probe.format.duration), videoFrames: Number(video?.nb_read_frames), codecs: exp.probe.streams.map(s => s.codec_name)}};
  };
  const manifest = {
    version: 1, createdAt: new Date().toISOString(), ticksPerSecond: T,
    note: "Synthetic speech (macOS say, one voice) over a testsrc2 picture; not creator footage. Both renders come from one live Shway project; the edited render is the baseline plus one committed replacement (one undo step).",
    source: {file: basename(mediaPath), sha256: sha(mediaPath), transcript: basename(transcriptPath), transcriptSha256: sha(transcriptPath)},
    renders: [render("baseline", baseline, baseline.export), {...render("edited", edited, edited.export), edit: edited.edit}],
  };
  copyFileSync(transcriptPath, join(dir, basename(transcriptPath)));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}
