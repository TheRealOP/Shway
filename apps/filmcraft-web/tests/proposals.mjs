// DEV-87 integration against the real browser engine and typed adapter.
// Called by foundation.mjs --proposals after source-backed import/playback.
export async function checkProposals({evaluate, screenshot}) {
  const result = await evaluate(`(${browserScenario.toString()})()`, 120000);
  if (screenshot) result.screenshot = await screenshot("02-proposal-preview");
  await evaluate("document.getElementById('shway-proposal-test-preview')?.remove()");
  return result;
}

async function browserScenario() {
  const {ShwayAdapter} = await import('/adapter.js');
  const adapter = await ShwayAdapter.connect(window.filmcraft);
  const gates = {};
  function check(name, condition) {
    gates[name] = Boolean(condition);
    if (!condition) throw new Error(`Proposal integration failed: ${name}`);
  }
  async function rejects(name, action) {
    let failed = false;
    try {await action();} catch {failed = true;}
    check(name, failed);
  }
  function timeline(sequence) {
    return JSON.stringify({id: sequence.id, settings: sequence.settings, duration: sequence.duration, video: sequence.video, audio: sequence.audio});
  }
  const initial = await adapter.inspect();
  const clip = initial.sequence.video.flatMap(track => track.items)[0];
  const base = timeline(initial.sequence);
  const source = clip.item;
  const step = deltaFrames => ({command: 'timeline.trim', params: {clip: clip.clip, source, edge: 'out', mode: 'regular', deltaFrames}});
  const proposal = async steps => {
    const current = await adapter.inspect();
    return {expectedRevision: current.project.revision, sequence: current.sequence.id, label: 'Shway preview trim', steps};
  };
  const history = await filmcraft.execute('history.list');
  const first = await adapter.preview(await proposal([step(-5), step(-10)]));
  check('stagingPreservesAuthoritativeTimeline', timeline((await adapter.inspect()).sequence) === base);
  check('stagingPreservesHistory', JSON.stringify(await filmcraft.execute('history.list')) === JSON.stringify(history));
  check('candidateContainsBothEdits', first.sequence.video.flatMap(track => track.items)[0].durationFrames === clip.durationFrames - 15);
  check('candidateInspectable', timeline((await adapter.inspectPreview(first.token)).sequence) === timeline(first.sequence));
  const rendered = await adapter.previewFrame(first.token, 0, 128);
  check('candidateFrame', rendered.width > 0 && rendered.height > 0 && rendered.width <= 128 && rendered.height <= 128 && rendered.rgba.length === rendered.width * rendered.height * 4 && rendered.rgba.some(value => value !== 0));
  check('cancelAcknowledged', (await adapter.cancel(first.token)).cancelled === true);
  check('cancelPreservesTimeline', timeline((await adapter.inspect()).sequence) === base);
  check('cancelPreservesHistory', JSON.stringify(await filmcraft.execute('history.list')) === JSON.stringify(history));
  await rejects('cancelledTokenRejected', () => adapter.commit(first.token));

  const second = await adapter.preview(await proposal([step(-5), step(-10)]));
  check('commitAcknowledged', (await adapter.commit(second.token)).committed === true);
  const changedHistory = await filmcraft.execute('history.list');
  check('multiStepOneUndo', changedHistory.undo.length === history.undo.length + 1);
  check('undoLabel', (await adapter.undo()).undone === 'Shway preview trim');
  check('multiStepUndoRestoresTimeline', timeline((await adapter.inspect()).sequence) === base);

  const stale = await adapter.preview(await proposal([step(-5)]));
  await filmcraft.execute('timeline.trim', {clip: clip.clip, edge: 'out', mode: 'regular', deltaFrames: -1});
  await rejects('staleCommitRejected', () => adapter.commit(stale.token));
  await adapter.cancel(stale.token);
  await adapter.undo();
  check('staleFailureRecoverable', timeline((await adapter.inspect()).sequence) === base);

  const valid = await proposal([step(-5)]);
  await rejects('unknownOperationRejectedByEngine', () => filmcraft.execute('proposal.preview', {...valid, steps: [{command: 'file.save', params: {path: '/unwanted.fcproj'}}]}));
  await rejects('oversizedBatchRejectedByEngine', () => filmcraft.execute('proposal.preview', {...valid, steps: Array.from({length: 17}, () => step(-1))}));
  await rejects('partialFailureRollsBack', () => filmcraft.execute('proposal.preview', {...valid, steps: [step(-5), {...step(-5), params: {...step(-5).params, clip: 999999999}}]}));
  check('invalidProposalsPreserveTimeline', timeline((await adapter.inspect()).sequence) === base);

  const importedShort = await filmcraft.importUrl('/short.mp4');
  check('shortSourceImported', importedShort.errors.length === 0 && importedShort.items.length === 1);
  await rejects('shortReplacementRejected', async () => adapter.preview(await proposal([{command: 'clip.replaceFromBin', params: {clips: [clip.clip], item: importedShort.items[0], keepSourceIn: false}}])));
  check('shortReplacementPreservesTimeline', timeline((await adapter.inspect()).sequence) === base);
  const importedAlternative = await filmcraft.importUrl('/alternative.mp4');
  check('alternativeImported', importedAlternative.errors.length === 0 && importedAlternative.items.length === 1);
  const replacement = await adapter.preview(await proposal([{command: 'clip.replaceFromBin', params: {clips: [clip.clip], item: importedAlternative.items[0], keepSourceIn: false}}]));
  const linked = [...replacement.sequence.video, ...replacement.sequence.audio].flatMap(track => track.items).filter(value => value.link === clip.link);
  check('replacementPreservesLinkedAV', linked.length >= 2 && linked.every(value => value.item === importedAlternative.items[0] && value.duration === clip.duration && value.sourceIn === 0));
  const frame = await adapter.previewFrame(replacement.token, 0, 128);
  check('replacementPreviewDiffers', frame.rgba.some((value, index) => value !== rendered.rgba[index]));
  const canvas = document.createElement('canvas');
  canvas.id = 'shway-proposal-test-preview';
  canvas.width = frame.width; canvas.height = frame.height;
  canvas.style.cssText = 'position:fixed;right:16px;top:60px;width:256px;border:2px solid white;z-index:9999';
  document.body.append(canvas);
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(frame.rgba), frame.width, frame.height), 0, 0);
  check('replacementCancelled', (await adapter.cancel(replacement.token)).cancelled === true);
  check('replacementCancelRestoresTimeline', timeline((await adapter.inspect()).sequence) === base);
  return {ok: true, gates, render: {width: frame.width, height: frame.height}};
}
