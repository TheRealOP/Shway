// DEV-88 integration: word-timed transcript import through the typed adapter into the real
// browser engine, then take indexing. Called by foundation.mjs --transcripts after the source-backed
// sequence exists. Needs adapter.js and takes.js (node shway/build.mjs) next to index.html.
export async function checkTranscripts({evaluate}) {
  return evaluate(`(${browserScenario.toString()})()`, 120000);
}

async function browserScenario() {
  const {ShwayAdapter} = await import('/adapter.js');
  const {indexTakes} = await import('/takes.js');
  const adapter = await ShwayAdapter.connect(window.filmcraft);
  const gates = {};
  function check(name, condition) {
    gates[name] = Boolean(condition);
    if (!condition) throw new Error(`Transcript integration failed: ${name}`);
  }
  const {sequence} = await adapter.inspect();
  const clip = sequence.video.flatMap(track => track.items)[0];
  const item = clip.item;
  const ticksPerSecond = 254016000000;
  // Three takes of two script lines, spread evenly over the (short) generated fixture.
  const lines = ['Welcome to the workshop.', 'Today we build a gesture editor.', 'Welcome to the workshop.', 'Today we, uh, build a gesture editor.', 'Welcome to our workshop.', 'Today we build a gesture editor!'];
  const texts = lines.flatMap(line => line.split(' '));
  const step = (clip.sourceOut / ticksPerSecond) / (texts.length + 1);
  const words = texts.map((text, i) => ({text, start: (i + 0.5) * step, end: (i + 1.25) * step}));
  const history = (await filmcraft.execute('history.list')).undo.length;

  let rejected = false;
  try {await adapter.importTranscript({sourceItemId: item, timeUnit: 'seconds', language: 'en', words: [{text: 'late', start: 0, end: clip.sourceOut / ticksPerSecond + 1}]});} catch {rejected = true;}
  check('outOfRangeRejectedBeforeEngine', rejected && (await filmcraft.execute('history.list')).undo.length === history);

  const imported = await adapter.importTranscript({sourceItemId: item, timeUnit: 'seconds', language: 'en', words});
  const after = await filmcraft.execute('history.list');
  check('oneUndoableEdit', after.undo.length === history + 1 && after.undo.at(-1) === 'Set Transcript');
  const inspected = await filmcraft.execute('transcript.inspect');
  check('storedOnSourceItem', inspected.items.some(t => t.item === item && t.words === texts.length && t.language === 'en' && t.source === 'imported'));
  // The sequence starts at 0 with sourceIn 0, so sequence word ticks equal imported source ticks.
  check('exactTicksThroughSequence', inspected.words.length === texts.length && inspected.words.every((w, i) => w.item === item && w.start === imported.words[i].start && w.end === imported.words[i].end));
  const search = await filmcraft.execute('transcript.search', {query: 'gesture editor'});
  check('searchableInEngine', search.matches.length === 3);

  const takes = indexTakes([imported], ['Welcome to the workshop.', 'Today we build a gesture editor.']);
  check('threeTakesPerStatement', [0, 1].every(s => takes.filter(t => t.statementIndex === s).length === 3));
  check('takesUseSourceIds', takes.every(t => t.sourceItemId === item && t.sourceIn < t.sourceOut && t.sourceOut <= clip.sourceOut));

  const undone = await adapter.undo();
  check('undoRemovesTranscript', undone.undone === 'Set Transcript' && (await filmcraft.execute('transcript.inspect')).items.length === 0);
  return {ok: true, gates, item, words: texts.length, takes: takes.map(t => ({statementIndex: t.statementIndex, sourceIn: t.sourceIn, sourceOut: t.sourceOut, score: t.score, text: t.words.map(w => w.text).join(' ')}))};
}
