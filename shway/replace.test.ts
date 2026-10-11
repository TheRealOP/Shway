// Take replacement from a spoken correction, with fake model and adapter. Run: node --test shway/*.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {prepareReplacement, proposeReplacement, stageReplacement} from "./replace.ts";
import type {ReplacementInput} from "./replace.ts";
import {AdapterError} from "./adapter.ts";
import type {EditProposal, SequenceInspection} from "./adapter.ts";
import {TICKS_PER_SECOND as T} from "./takes.ts";
import type {Take} from "./takes.ts";

const F = T / 24; // 24 fps frame
const OFF = 0.6 * F; // word times off the frame grid: rounding would clip the first/last word
const take = (sourceItemId: number, inFrames: number, outFrames: number, text: string, statementIndex = 0): Take => ({
  sourceItemId, sourceIn: inFrames * F + OFF, sourceOut: outFrames * F - OFF, statementIndex, score: 1,
  words: text.split(" ").map((w, i) => ({text: w, start: inFrames * F + OFF + i, end: inFrames * F + OFF + 1 + i})),
});
// Statement 0 has three takes: in source 31 (frames 10–58), later in 31 (frames 100–160), and source 32 (frames 4–40).
const TAKES = [
  take(31, 10, 58, "Welcome to the workshop."),
  take(31, 100, 160, "Welcome to the [laughs] workshop."),
  take(32, 4, 40, "Welcome to our workshop."),
  take(31, 200, 230, "Today we build.", 1),
];
function sequence(inFrames = 10, outFrames = 58): SequenceInspection {
  const clip = (id: number) => ({clip: id, item: 31, start: 0, duration: (outFrames - inFrames) * F, sourceIn: inFrames * F, sourceOut: outFrames * F, link: 5});
  return {id: 7, duration: (outFrames - inFrames) * F, settings: {frame_rate: {num: 24, den: 1}},
    video: [{id: 11, items: [clip(21)]}, {id: 13, items: [{...clip(24), link: 6}]}], audio: [{id: 12, items: [clip(22), {clip: 23, item: 33, start: 0, duration: F, sourceIn: 0, sourceOut: F}]}]};
}
const CONTEXT = {revision: 4, sequence: 7, selection: [21], target: 21, playhead: 0};

function fixture(opts: {answer?: unknown; preview?: (p: EditProposal) => unknown; clip?: [number, number]} = {}) {
  const calls: string[] = [];
  const prompts: string[] = [];
  let proposal: EditProposal | null = null;
  const adapter = {
    inspect: async () => {calls.push("inspect"); return {project: {revision: 4, activeSequence: 7}, sequence: sequence(...(opts.clip ?? []))};},
    preview: async (p: EditProposal) => {
      calls.push("preview"); proposal = p;
      if (opts.preview) return opts.preview(p) as never;
      // Simulate the engine: the staged clip plays what the steps describe (computed independently).
      const s = sequence(...(opts.clip ?? []));
      for (const v of [s.video[0].items[0], s.audio[0].items[0]]) for (const step of p.steps) { // linked pair moves together
        if (step.command === "clip.replaceFromBin") {v.item = step.params.item; v.sourceIn = 0;}
        else if (step.params.edge === "in") {v.sourceIn += step.params.deltaFrames * F; v.duration -= step.params.deltaFrames * F;}
        else v.duration += step.params.deltaFrames * F;
      }
      return {token: 9, expectedRevision: 4, label: p.label, sequence: s, results: []};
    },
    cancel: async () => {calls.push("cancel"); return {cancelled: true as const};},
  };
  const generate = async (r: {prompt: string}) => {calls.push("generate"); prompts.push(r.prompt); return "answer" in opts ? opts.answer : {take: 1, explanation: "Take 1 has the laugh."};};
  const input = (patch: Partial<ReplacementInput> = {}): ReplacementInput => ({
    utterance: {transcript: {text: "That sounds rehearsed; use the take where I laugh"}, context: CONTEXT},
    takes: TAKES, generate, adapter, ...patch,
  });
  return {calls, prompts, input, proposal: () => proposal};
}

test("happy path: the laughing take of the same line is previewed with exact frame steps", async () => {
  const f = fixture();
  const r = await proposeReplacement(f.input());
  assert.equal(r.status, "preview");
  if (r.status !== "preview") return;
  assert.equal(r.token, 9);
  assert.equal(r.take, TAKES[1]);
  assert.equal(r.from, TAKES[0]);
  assert.equal(r.explanation, "Take 1 has the laugh.");
  // Same source: slip and lengthen in place with two ripple trims, out first (no gap, no empty range).
  assert.deepEqual(f.proposal(), {expectedRevision: 4, sequence: 7, label: 'Replace take: "Welcome to the [laughs] workshop."', steps: [
    {command: "timeline.trim", params: {clip: 21, source: 31, edge: "out", mode: "ripple", deltaFrames: 150 - 48}},
    {command: "timeline.trim", params: {clip: 21, source: 31, edge: "in", mode: "ripple", deltaFrames: 90}},
  ]});
  assert.deepEqual(f.calls, ["inspect", "generate", "preview"]);
  // Model sees opaque indices and words of this statement only, never IDs or times.
  assert.match(f.prompts[0], /0 \(current\): "Welcome to the workshop\."\n1: "Welcome to the \[laughs\] workshop\."\n2: "Welcome to our workshop\."$/);
  assert.doesNotMatch(f.prompts[0], /Today|31|32/);
});

test("another source item is replaced from bin; shorter takes are trimmed first", async () => {
  const f = fixture({answer: {take: 2, explanation: "Warmer wording."}});
  const r = await proposeReplacement(f.input());
  assert.equal(r.status, "preview");
  assert.deepEqual(f.proposal()!.steps, [
    {command: "timeline.trim", params: {clip: 21, source: 31, edge: "out", mode: "ripple", deltaFrames: 36 - 48}},
    {command: "clip.replaceFromBin", params: {clips: [21], item: 32}},
    {command: "timeline.trim", params: {clip: 21, source: 32, edge: "out", mode: "ripple", deltaFrames: 4}},
    {command: "timeline.trim", params: {clip: 21, source: 32, edge: "in", mode: "ripple", deltaFrames: 4}},
  ]);
});

test("an earlier take is reached by extending the In first", async () => {
  const takes = [take(31, 100, 160, "Hello there"), take(31, 10, 40, "Hello [laughs] there")];
  const f = fixture({answer: {take: 1, explanation: "laugh"}, clip: [100, 160]});
  const r = await proposeReplacement(f.input({takes}));
  assert.equal(r.status, "preview");
  assert.deepEqual(f.proposal()!.steps, [
    {command: "timeline.trim", params: {clip: 21, source: 31, edge: "in", mode: "ripple", deltaFrames: -90}},
    {command: "timeline.trim", params: {clip: 21, source: 31, edge: "out", mode: "ripple", deltaFrames: -120}},
  ]);
});

test("no, several or unknown selections ask for an explicit selection without calling the model", async () => {
  for (const selection of [[], [21, 23], [999], [22, 23], [21, 24]]) {
    const f = fixture();
    const r = await proposeReplacement(f.input({context: {...CONTEXT, selection}}));
    assert.equal(r.status, "need-selection", JSON.stringify(selection));
    if (!selection.length) assert.match((r as {message: string}).message, /^Select the clip/);
    assert.deepEqual(f.calls, ["inspect"]);
  }
  for (const context of [null, {revision: 4, sequence: 7}, {sequence: 7, selection: [21]}, {...CONTEXT, selection: [1.5]}]) {
    const f = fixture();
    const r = await proposeReplacement(f.input({utterance: {transcript: {text: "use the laugh"}, context}}));
    assert.equal(r.status, "need-selection");
    assert.deepEqual(f.calls, []);
  }
  const f = fixture();
  assert.equal((await proposeReplacement(f.input({context: {...CONTEXT, sequence: 8}}))).status, "need-selection");
  assert.deepEqual(f.calls, ["inspect"]);
  // The linked A/V pair counts as one clip; the audio half resolves to the same take.
  for (const selection of [[21, 22], [22]]) {
    const f = fixture();
    assert.equal((await proposeReplacement(f.input({context: {...CONTEXT, selection}}))).status, "preview", JSON.stringify(selection));
  }
});

test("invented, current or declined takes change nothing", async () => {
  for (const answer of [{take: 3, explanation: "x"}, {take: 1.5}, {take: "1"}, {take: -2}, null, {take: 0, explanation: "same"}, {take: -1, explanation: "None laugh."}]) {
    const f = fixture({answer});
    const r = await proposeReplacement(f.input());
    assert.equal(r.status, "rejected", JSON.stringify(answer));
    assert.ok(!f.calls.includes("preview"));
  }
  const f = fixture({answer: {take: -1, explanation: "None laugh."}});
  assert.deepEqual(await proposeReplacement(f.input()), {status: "rejected", message: "None laugh."});
});

test("missing transcript, unindexed clip or a lone take never reach the model", async () => {
  let f = fixture();
  assert.equal((await proposeReplacement(f.input({utterance: {transcript: null, context: CONTEXT}}))).status, "rejected");
  f = fixture();
  assert.equal((await proposeReplacement(f.input({takes: [take(32, 10, 58, "a b"), take(32, 100, 160, "a b c")]}))).status, "no-take");
  f = fixture();
  assert.equal((await proposeReplacement(f.input({takes: [TAKES[0], TAKES[3]]}))).status, "no-take");
  assert.ok(!f.calls.includes("generate"));
});

test("stale revision and engine rejections pass through for re-planning", async () => {
  const stale = new AdapterError("stale", "Project revision or active sequence changed; inspect and re-plan the proposal");
  let f = fixture({preview: () => {throw stale;}});
  await assert.rejects(proposeReplacement(f.input()), error => error === stale);
  const short = new Error("edit proposal: clip range must be positive and contained in its source");
  f = fixture({preview: () => {throw short;}});
  await assert.rejects(proposeReplacement(f.input()), error => error === short);
  // The context snapshot's revision is what the proposal expects, not a fresher one.
  f = fixture({preview: () => {throw stale;}});
  await assert.rejects(proposeReplacement(f.input({context: {...CONTEXT, revision: 3}})));
  assert.equal(f.proposal()!.expectedRevision, 3);
});

test("a preview staging another item or range is cancelled", async () => {
  const staged = [{item: 31, sourceIn: 10 * F, duration: 48 * F}, {item: 32, sourceIn: 100 * F, duration: 60 * F},
    {item: 31, sourceIn: 101 * F, duration: 60 * F}, {item: 31, sourceIn: 100 * F, duration: 59 * F}];
  for (const patch of staged) {
    const f = fixture({preview: p => {const s = sequence(); Object.assign(s.video[0].items[0], patch); return {token: 9, expectedRevision: 4, label: p.label, sequence: s, results: []};}});
    const r = await proposeReplacement(f.input());
    assert.equal(r.status, "rejected", JSON.stringify(patch));
    assert.deepEqual(f.calls, ["inspect", "generate", "preview", "cancel"]);
  }
});

test("decider contract: grounded candidates without a model call; only offered ids stage", async () => {
  const f = fixture();
  const p = await prepareReplacement(f.input());
  assert.equal(p.status, "candidates");
  if (p.status !== "candidates") return;
  assert.deepEqual(p.candidates.map(c => [c.id, c.words, c.current]), [
    ["take-0", "Welcome to the workshop.", true], ["take-1", "Welcome to the [laughs] workshop.", false], ["take-2", "Welcome to our workshop.", false]]);
  assert.deepEqual(f.calls, ["inspect"]);
  const {adapter} = f.input();
  for (const choice of ["review", "no-change", "take-0", "take-9", "take-1 ", ""]) {
    assert.equal((await stageReplacement(p, choice, "", adapter)).status, "rejected", choice);
  }
  assert.deepEqual(f.calls, ["inspect"]);
  const r = await stageReplacement(p, "take-1", "Jev picked the laugh.", adapter);
  assert.equal(r.status, "preview");
  assert.deepEqual(f.calls, ["inspect", "preview"]);
  assert.equal(f.proposal()?.expectedRevision, 4); // bound to the push-to-talk snapshot
});

test("jevDecide sends named choices without ids or times; low confidence becomes review", async () => {
  const {jevDecide} = await import("./replace.ts");
  const sent: any[] = [];
  let answer: any = {type: "choice", choice: "take-1", confidence: 0.97, probabilities: {}};
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: {body: string}) => {
    sent.push(JSON.parse(init.body));
    return {ok: true, status: 200, json: async () => ({model: "jev-1.13.0", answers: {take: answer}})};
  }) as never;
  try {
    const f = fixture();
    const r = await proposeReplacement({...f.input(), generate: undefined, decide: jevDecide("http://proxy")});
    assert.equal(r.status, "preview");
    if (r.status === "preview") assert.equal(r.take, TAKES[1]);
    assert.match(r.status === "preview" ? r.explanation : "", /Jev \(jev-1\.13\.0, confidence 0\.97\) chose/);
    const q = sent[0];
    assert.deepEqual(Object.keys(q.questions.take.criteria), ["take-1", "take-2", "no-change", "review"]); // current take not offered
    assert.equal(q.state.current_take, "Welcome to the workshop.");
    assert.doesNotMatch(JSON.stringify(q), /31|32|sourceIn/);
    for (const [a, status] of [[{...answer, confidence: 0.4}, "rejected"], [{...answer, choice: "take-0"}, "rejected"], [{...answer, choice: "made-up"}, "rejected"], [{...answer, choice: "review"}, "rejected"]] as const) {
      answer = a;
      const g = fixture();
      assert.equal((await proposeReplacement({...g.input(), generate: undefined, decide: jevDecide("http://proxy")})).status, status);
      assert.ok(!g.calls.includes("preview"), JSON.stringify(a));
    }
  } finally {globalThis.fetch = realFetch;}
});
