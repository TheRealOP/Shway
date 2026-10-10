// DEV-98 integration: the creator chain on spoken media in the real browser engine.
// Word-timed transcript → take index → live Gemini first cut → commit → typed correction on the
// selected clip → live Gemini replacement → commit. Called by foundation.mjs --creator after import;
// foundation.mjs then saves, undoes, reopens and exports the result. Needs adapter.js, takes.js,
// firstcut.js and replace.js (node shway/build.mjs) next to index.html, and the Gemini proxy.
import {readFileSync} from "node:fs";

export async function checkCreator({evaluate, item, transcriptPath, proxy}) {
  const transcript = JSON.parse(readFileSync(transcriptPath, "utf8"));
  return evaluate(`(${browserScenario.toString()})(${JSON.stringify({item, transcript, proxy})})`, 300000);
}

async function browserScenario({item, transcript, proxy}) {
  const {ShwayAdapter} = await import('/adapter.js');
  const {parseTranscript, indexTakes} = await import('/takes.js');
  const {parseBrief, planFirstCut, assembleFirstCut, proxyGenerate} = await import('/firstcut.js');
  const {proposeReplacement, geminiGenerate} = await import('/replace.js');
  const gates = {};
  function check(name, condition, detail) {
    gates[name] = Boolean(condition);
    if (!condition) throw new Error(`Creator chain failed: ${name} ${JSON.stringify(detail ?? null)}`);
  }
  const text = take => take.words.map(w => w.text).join(' ');
  const timeline = s => [...s.video, ...s.audio].map(t => t.items.map(c => [c.item, c.start, c.duration, c.sourceIn]));
  const adapter = await ShwayAdapter.connect(window.filmcraft);
  await filmcraft.execute('file.newSequence', {name: 'AI first cut'});

  const source = parseTranscript({...transcript, sourceItemId: item});
  await adapter.importTranscript({...transcript, sourceItemId: item});
  const script = ['Welcome to the workshop.', 'Today we build a gesture editor.'];
  const takes = indexTakes([source], script);
  check('takesIndexed', [0, 1].every(s => takes.filter(t => t.statementIndex === s).length === 3), takes.map(text));

  const brief = parseBrief({message: 'Shway lets creators edit video with their hands and voice.', audience: 'Hackathon judges',
    feeling: 'Confident and welcoming', durationSeconds: 10, requiredMoments: ['the welcome', 'what we build'], exclusions: ['filler words such as uh and um']});
  let started = performance.now();
  const plan = await planFirstCut({brief, script, takes, generate: proxyGenerate(`${proxy}/generate`)});
  const planMs = performance.now() - started;
  check('onePerLine', plan.choices.length === 2 && plan.skipped.length === 0, plan);
  check('fillerAvoided', plan.choices.every(c => !/\b(uh|um)\b/i.test(text(c.take))), plan.choices.map(c => text(c.take)));
  const cut = await assembleFirstCut(adapter, plan);
  const before = await adapter.inspect();
  check('cutStagedOnly', before.sequence.video.every(t => t.items.length === 0), timeline(before.sequence));
  await adapter.commit(cut.token);
  const afterCut = await adapter.inspect();
  const history = (await filmcraft.execute('history.list')).undo;
  check('cutOneUndo', history.at(-1) === 'AI first cut', history);
  const v1 = afterCut.sequence.video[0].items;
  check('cutTwoLinkedClips', v1.length === 2 && afterCut.sequence.audio[0].items.length === 2, timeline(afterCut.sequence));

  // The creator selects the opening line and corrects it (typed here; the demo page transcribes speech).
  const line1 = v1[0];
  await adapter.select([line1.clip]);
  const context = {revision: afterCut.project.revision, sequence: afterCut.sequence.id, selection: [line1.clip]};
  // Ask for whichever clean wording the cut did not choose, so the correction always means a change.
  const wantOur = !/\bour\b/i.test(text(plan.choices[0].take));
  const correction = wantOur ? 'I prefer the take where I say "our workshop".' : 'Say "the workshop", not "our workshop", and keep it clean with no filler.';
  started = performance.now();
  const r = await proposeReplacement({transcript: correction, context, takes, generate: geminiGenerate(proxy), adapter});
  const replaceMs = performance.now() - started;
  check('replacementPreview', r.status === 'preview', r);
  check('chosenRequestedTake', wantOur ? /\bour\b/i.test(text(r.take)) : !/\b(our|uh|um)\b/i.test(text(r.take)), text(r.take));
  const staged = await adapter.inspect();
  check('authoritativeUnchanged', JSON.stringify(timeline(staged.sequence)) === JSON.stringify(timeline(afterCut.sequence)));
  const frame = await adapter.previewFrame(r.token, 0, 64);
  check('candidateFrame', frame.width > 0 && frame.rgba.length === frame.width * frame.height * 4);
  await adapter.commit(r.token);
  const final = await adapter.inspect();
  const finalHistory = (await filmcraft.execute('history.list')).undo;
  check('replaceOneUndo', finalHistory.length === history.length + 1 && finalHistory.at(-1).startsWith('Replace take'), finalHistory);
  const replaced = final.sequence.video[0].items[0];
  check('clipNowPlaysTake', replaced.item === r.take.sourceItemId && replaced.sourceIn <= r.take.sourceIn && replaced.sourceIn + replaced.duration >= r.take.sourceOut, {replaced, take: r.take});

  return {ok: true, gates, planMs, replaceMs, takes: takes.map(t => ({statementIndex: t.statementIndex, text: text(t), score: t.score})),
    firstCut: plan.choices.map(c => ({statementIndex: c.statementIndex, take: text(c.take), reason: c.reason})),
    replacement: {correction, from: text(r.from), to: text(r.take), explanation: r.explanation, label: r.label},
    expectedSpeech: [text(r.take), text(plan.choices[1].take)], history: finalHistory};
}
