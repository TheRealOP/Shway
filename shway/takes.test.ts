// Transcript validation, tick conversion, transcript.set import and take indexing.
import test from "node:test";
import assert from "node:assert/strict";
import {indexTakes, parseTranscript, TICKS_PER_SECOND, MAX_WORDS, TranscriptError} from "./takes.ts";
import type {TranscriptInput} from "./takes.ts";
import {ShwayAdapter, AdapterError} from "./adapter.ts";
import type {FilmcraftTransport} from "./adapter.ts";

const T = TICKS_PER_SECOND;
// Hand-written recording: three takes of the same two lines, with a stumble, a filler and a
// paraphrase. Each word lasts 0.4 s with 0.1 s gaps.
const LINES = [
  "Welcome to the workshop.", "Today we, uh, build a gesture editor.",
  "Welcome to the workshop.", "Today we build a gesture editor.",
  "Welcome to our workshop.", "Today we build a gesture editor!",
];
function recording(lines: string[], sourceItemId = 41): TranscriptInput {
  const words: TranscriptInput["words"] = [];
  let t = 0.5;
  for (const line of lines) {
    for (const text of line.split(" ")) {words.push({text, start: t, end: t + 0.4, confidence: 0.9}); t += 0.5;}
    t += 1;
  }
  return {sourceItemId, timeUnit: "seconds", language: "en", words};
}
const SCRIPT = ["Welcome to the workshop.", "Today we build a gesture editor."];
const rejects = (value: unknown, duration?: number) => assert.throws(() => parseTranscript(value, duration), TranscriptError, JSON.stringify(value)?.slice(0, 200));

test("seconds convert to exact engine ticks at the boundary", () => {
  const t = parseTranscript({sourceItemId: 41, timeUnit: "seconds", words: [{text: " Hi ", start: 1.5, end: 2}]});
  assert.deepEqual(t, {sourceItemId: 41, language: "", words: [{text: "Hi", start: 1.5 * T, end: 2 * T}]});
  assert.equal(t.words[0].start, 381_024_000_000);
  const ticks = parseTranscript({sourceItemId: 41, timeUnit: "ticks", words: [{text: "a", start: 7, end: 7}]});
  assert.deepEqual(ticks.words, [{text: "a", start: 7, end: 7}]);
});

test("hostile transcripts are rejected", () => {
  const ok = () => ({sourceItemId: 41, timeUnit: "seconds", words: [{text: "a", start: 0, end: 1}, {text: "b", start: 1, end: 2}]});
  const word = (patch: Record<string, unknown>) => ({...ok(), words: [{...ok().words[0], ...patch}]});
  for (const value of [
    null, [], {...ok(), extra: 1}, {...ok(), sourceItemId: 0}, {...ok(), sourceItemId: 1.5}, {...ok(), sourceItemId: Number.MAX_SAFE_INTEGER + 1},
    {...ok(), timeUnit: undefined}, {...ok(), timeUnit: "ms"}, {...ok(), language: "English"}, {...ok(), language: 3},
    {...ok(), words: []}, {...ok(), words: "a"}, {...ok(), words: [null]},
    word({start: NaN}), word({end: NaN}), word({start: Infinity}), word({start: -1}), word({end: -0.5}), word({start: "0"}),
    word({start: 2, end: 1}), word({text: ""}), word({text: "   "}), word({text: 5}), word({text: "x".repeat(101)}),
    word({confidence: 1.5}), word({confidence: -0.1}), word({confidence: NaN}), word({speaker: 1}),
    word({end: 1e6}), // 1e6 s exceeds exact browser-integer ticks
    {...ok(), timeUnit: "ticks", words: [{text: "a", start: 0.5, end: 1}]},
    {...ok(), words: [{text: "a", start: 0, end: 1}, {text: "b", start: 0.9, end: 2}]}, // overlap
    {...ok(), words: [{text: "a", start: 1, end: 2}, {text: "b", start: 0, end: 0.5}]}, // unordered
    {...ok(), words: Array.from({length: MAX_WORDS + 1}, (_, i) => ({text: "w", start: i, end: i}))},
  ]) rejects(value);
  // Negative times get a direct error (the overlap guard would also reject them, misleadingly).
  assert.throws(() => parseTranscript(word({start: -1})), /must be a number >= 0/);
  rejects({...ok(), language: {toString: () => "en"}});
  rejects(ok(), 2 * T - 1); // out of source range
  rejects(ok(), NaN);
  assert.equal(parseTranscript(ok(), 2 * T).words.length, 2);
});

test("three takes of each line are indexed per statement with exact source ranges", () => {
  const source = parseTranscript(recording(LINES));
  const other = parseTranscript(recording(["Today we build a gesture editor."], 42));
  const takes = indexTakes([source, other], SCRIPT);
  assert.deepEqual(takes.map(t => [t.statementIndex, t.sourceItemId, t.words.map(w => w.text).join(" ")]), [
    [0, 41, "Welcome to the workshop."],
    [0, 41, "Welcome to the workshop."],
    [0, 41, "Welcome to our workshop."],
    [1, 41, "Today we, uh, build a gesture editor."],
    [1, 41, "Today we build a gesture editor."],
    [1, 41, "Today we build a gesture editor!"],
    [1, 42, "Today we build a gesture editor."],
  ]);
  for (const take of takes) {
    assert.equal(take.sourceIn, take.words[0].start);
    assert.equal(take.sourceOut, take.words.at(-1)!.end);
    assert.ok(Number.isSafeInteger(take.sourceIn) && Number.isSafeInteger(take.sourceOut));
  }
  assert.equal(takes[0].sourceIn, 0.5 * T);
  assert.equal(takes[0].score, 1);
  assert.equal(takes[2].score, 0.75);
  assert.ok(takes[3].score < 1 && takes[3].score > 0.9, "filler lowers but keeps the take");
  assert.deepEqual(indexTakes([other, source], SCRIPT), takes, "deterministic regardless of input order");
  assert.deepEqual(indexTakes([source], ["Something nobody said here."]), []);
  assert.deepEqual(indexTakes([source], ["Welcome friends and neighbours everywhere"]), [], "weak partial matches stay below minScore");
});

test("index inputs are bounded", () => {
  const source = parseTranscript(recording(LINES));
  assert.throws(() => indexTakes([source, source], SCRIPT), TranscriptError);
  assert.throws(() => indexTakes([source], []), TranscriptError);
  assert.throws(() => indexTakes([source], ["..."]), TranscriptError);
  assert.throws(() => indexTakes([source], ["w ".repeat(65)]), TranscriptError);
  assert.throws(() => indexTakes([source], Array(201).fill("hi")), TranscriptError);
  assert.throws(() => indexTakes([source], ["x".repeat(6401)]), TranscriptError);
  assert.throws(() => indexTakes(Array.from({length: 65}, (_, i) => ({...source, sourceItemId: i + 1})), SCRIPT), TranscriptError);
  assert.throws(() => indexTakes([source], SCRIPT, 0), TranscriptError);
  assert.throws(() => indexTakes([source], SCRIPT, NaN), TranscriptError);
  assert.throws(() => indexTakes([{...source, words: [{text: "a", start: -1, end: 0}]}], SCRIPT), TranscriptError);
  const big = Array.from({length: 4}, (_, i) => parseTranscript({sourceItemId: i + 1, timeUnit: "ticks", words: Array.from({length: MAX_WORDS}, (_, j) => ({text: "w", start: j, end: j}))}));
  assert.throws(() => indexTakes(big, Array(200).fill("a b c")), /too large/);
});

function engine(project: unknown, handler?: (command: string, params: Record<string, unknown>) => unknown) {
  const calls: {command: string; params: Record<string, unknown>}[] = [];
  const ids = ["project.inspect", "sequence.inspect", "timeline.select", "playhead.set", "edit.undo", "file.exportMedia", "jobs.list", "proposal.preview", "proposal.inspect", "proposal.cancel", "proposal.commit", "proposal.render", "transcript.set"];
  const transport: FilmcraftTransport = {
    commands: async () => ids.map(id => ({id})),
    execute: async (command, params = {}) => {
      calls.push({command, params});
      const response = handler?.(command, params);
      if (response !== undefined) return response;
      if (command === "project.inspect") return structuredClone(project);
      if (command === "transcript.set") return {item: params.item, words: (params.transcript as {words: unknown[]}).words.length};
      return {};
    },
    request: async () => ({}),
  };
  return {transport, calls, ids};
}
const PROJECT = {revision: 3, activeSequence: null, root: {id: 1, children: [
  {item: 40, type: "Sequence", duration: 999 * T},
  {id: 2, name: "Takes", children: [{item: 41, type: "Movie", duration: 30 * T}, {item: 42, type: "Audio", duration: 5 * T}]},
]}};
const code = (expected: string) => (error: unknown) => error instanceof AdapterError && error.code === expected;

test("importTranscript stores exact ticks on a recorded source through transcript.set", async () => {
  const {transport, calls} = engine(PROJECT);
  const adapter = await ShwayAdapter.connect(transport);
  const input = recording(LINES);
  const imported = await adapter.importTranscript(input);
  const set = calls.find(c => c.command === "transcript.set")!;
  assert.deepEqual(set.params, {item: 41, transcript: {language: "en", words: imported.words}});
  assert.equal(imported.words[0].start, 0.5 * T);
  assert.ok(imported.words.every(w => Number.isSafeInteger(w.start) && Number.isSafeInteger(w.end)));
});

test("importTranscript rejects invalid, unknown, non-media and out-of-range sources before transcript.set", async () => {
  const {transport, calls} = engine(PROJECT);
  const adapter = await ShwayAdapter.connect(transport);
  const short = recording(["Today we build a gesture editor."], 42); // ends at 3.4 s of a 5 s source
  const cases: unknown[] = [
    {...short, words: [{text: "a", start: NaN, end: 1}]},
    {...short, sourceItemId: 99},
    {...short, sourceItemId: 40},
    {...short, words: [{text: "late", start: 4.9, end: 5.1}]},
  ];
  for (const value of cases) await assert.rejects(adapter.importTranscript(value as TranscriptInput), code("invalid"));
  assert.equal(calls.filter(c => c.command === "transcript.set").length, 0);
  await adapter.importTranscript(short);
  assert.equal(calls.filter(c => c.command === "transcript.set").length, 1);
});

test("importTranscript checks the engine confirmation and capability", async () => {
  for (const reply of [{item: 41, words: 1}, {item: 7, words: recording(LINES).words.length}]) {
    const wrong = engine(PROJECT, command => command === "transcript.set" ? reply : undefined);
    await assert.rejects((await ShwayAdapter.connect(wrong.transport)).importTranscript(recording(LINES)), code("response"));
  }
  const missing = engine(PROJECT);
  missing.transport.commands = async () => missing.ids.filter(id => id !== "transcript.set").map(id => ({id}));
  await assert.rejects((await ShwayAdapter.connect(missing.transport)).importTranscript(recording(LINES)), code("capability"));
});
