// Transport-boundary tests; actual preview/commit/cancel/undo belongs to browser integration.
import test from "node:test";
import assert from "node:assert/strict";
import {ShwayAdapter, AdapterError, alignRange} from "./adapter.ts";
import type {EditProposal, FilmcraftTransport} from "./adapter.ts";

const capabilities = ["project.inspect", "sequence.inspect", "timeline.select", "playhead.set", "edit.undo", "file.exportMedia", "jobs.list", "proposal.preview", "proposal.inspect", "proposal.cancel", "proposal.commit", "proposal.render"];
const sequence = {
  id: 7, duration: 254016000000,
  video: [{id: 11, items: [{clip: 21, item: 31, start: 0, duration: 254016000000, sourceIn: 0, sourceOut: 254016000000}]}],
  audio: [{id: 12, items: [{clip: 22, item: 31, start: 0, duration: 254016000000, sourceIn: 0, sourceOut: 254016000000}]}],
};
const proposal = (): EditProposal => ({
  expectedRevision: 4, sequence: 7, label: "Shorten take",
  steps: [{command: "timeline.trim", params: {clip: 21, source: 31, edge: "out", mode: "regular", deltaFrames: -5}}],
});
function fixture(handler?: (command: string, params: Record<string, unknown>) => unknown) {
  const calls: {command: string; params: Record<string, unknown>}[] = [];
  const transport: FilmcraftTransport = {
    commands: async () => capabilities.map(id => ({id, enabled: false})),
    execute: async (command, params = {}) => {
      calls.push({command, params});
      if (handler) {
        const response = await handler(command, params);
        if (response !== undefined) return response;
      }
      if (command === "project.inspect") return {revision: 4, activeSequence: 7};
      if (command === "sequence.inspect") return structuredClone(sequence);
      if (command === "proposal.preview" || command === "proposal.inspect") return {token: 9, expectedRevision: 4, label: "Shorten take", sequence: structuredClone(sequence), results: [{delta: -42336000000}]};
      if (command === "proposal.render") return {width: 1, height: 1, rgba: [40, 80, 120, 255]};
      if (command === "proposal.commit") return {committed: true, revision: 5, label: "Shorten take"};
      if (command === "proposal.cancel") return {cancelled: true};
      if (command === "edit.undo") return {undone: "Shorten take"};
      if (command === "file.exportMedia") return {job: 2, path: params.path};
      if (command === "jobs.list") return [{id: 2, finished: true, result: {error: "Disk full"}}];
      return {};
    },
    request: async (method, params = {}) => {calls.push({command: method, params}); return {};},
  };
  return {transport, calls};
}
const code = (expected: string) => (error: unknown) => error instanceof AdapterError && error.code === expected;

test("missing proposal capability prevents connection without executing commands", async () => {
  const {transport, calls} = fixture();
  transport.commands = async () => capabilities.filter(id => id !== "proposal.commit").map(id => ({id}));
  await assert.rejects(ShwayAdapter.connect(transport), code("capability"));
  assert.equal(calls.length, 0);
});

test("unsafe IDs, unsupported commands and unknown fields never reach the engine", async () => {
  const {transport, calls} = fixture();
  const adapter = await ShwayAdapter.connect(transport);
  const invalid: unknown[] = [
    {...proposal(), sequence: Number.MAX_SAFE_INTEGER + 1},
    {...proposal(), expectedRevision: NaN},
    {...proposal(), expectedRevision: -1},
    {...proposal(), expectedRevision: 0},
    {...proposal(), label: "é".repeat(80)},
    {...proposal(), label: "x".repeat(1000000)},
    {...proposal(), steps: [{command: "file.newProject", params: {name: "unexpected"}}]},
    {...proposal(), steps: [{command: "timeline.trim", params: {...proposal().steps[0].params, deltaFrames: Infinity}}]},
    {...proposal(), steps: [{command: "timeline.trim", params: {...proposal().steps[0].params, clip: 1.5}}]},
    {...proposal(), steps: [{command: "timeline.trim", params: {...proposal().steps[0].params, seconds: 0.25}}]},
    {...proposal(), steps: [{command: "clip.replaceFromBin", params: {clips: [21, 21], item: 32}}]},
    {...proposal(), steps: [{command: "clip.replaceFromBin", params: {clips: new Array(1), item: 32}}]},
    {...proposal(), steps: new Array(1)},
    {...proposal(), autoplay: true},
  ];
  for (const value of invalid) await assert.rejects(adapter.preview(value as EditProposal), code("invalid"));
  assert.equal(calls.length, 0);
});

test("changed revision or active sequence requires replanning before preview dispatch", async () => {
  for (const context of [{revision: 5, activeSequence: 7}, {revision: 4, activeSequence: 8}]) {
    const {transport, calls} = fixture(command => command === "project.inspect" ? context : undefined);
    const adapter = await ShwayAdapter.connect(transport);
    await assert.rejects(adapter.preview(proposal()), code("stale"));
    assert.deepEqual(calls.map(call => call.command), ["project.inspect"]);
  }
});

test("a proposal is captured before asynchronous context reads", async () => {
  let resolveContext: (value: unknown) => void = () => {};
  const context = new Promise(resolve => {resolveContext = resolve;});
  const {transport, calls} = fixture(command => command === "project.inspect" ? context : undefined);
  const adapter = await ShwayAdapter.connect(transport);
  const input = proposal();
  const preview = adapter.preview(input);
  input.steps[0].params.clip = 99;
  input.expectedRevision = 99;
  resolveContext({revision: 4, activeSequence: 7});
  await preview;
  assert.deepEqual(calls.find(call => call.command === "proposal.preview")?.params, proposal());
});

test("engine stale rejection after context discovery propagates without retries", async () => {
  const stale = new Error("proposal.preview: stale revision");
  const {transport, calls} = fixture(command => {if (command === "proposal.preview") throw stale;});
  const adapter = await ShwayAdapter.connect(transport);
  await assert.rejects(adapter.preview(proposal()), error => error === stale);
  assert.equal(calls.filter(call => call.command === "proposal.preview").length, 1);
});

test("invalid staged reply is cancelled so the next proposal can proceed", async () => {
  let staged = false, previews = 0;
  const {transport, calls} = fixture(command => {
    if (command === "proposal.preview") {
      if (staged) throw new Error("cancel or commit the current preview");
      staged = true;
      return {token: 9, expectedRevision: 4, label: "Shorten take", results: [], sequence: {...structuredClone(sequence), duration: ++previews === 1 ? Number.MAX_SAFE_INTEGER + 1 : sequence.duration}};
    }
    if (command === "proposal.cancel") {staged = false; return {cancelled: true};}
  });
  const adapter = await ShwayAdapter.connect(transport);
  await assert.rejects(adapter.preview(proposal()), /sequence.duration must be a safe integer/);
  assert.equal(staged, false);
  assert.deepEqual(calls.find(call => call.command === "proposal.cancel")?.params, {token: 9});
  assert.equal((await adapter.preview(proposal())).token, 9);
  assert.equal(previews, 2);
});

test("preview cleanup preserves validation errors and never cancels an invalid token", async () => {
  for (const badToken of [false, true]) {
    const {transport, calls} = fixture(command => {
      if (command === "proposal.preview") return {token: badToken ? 0 : 9, expectedRevision: 5, label: "Shorten take", results: [], sequence};
      if (command === "proposal.cancel") throw new Error("cleanup transport failed");
    });
    const adapter = await ShwayAdapter.connect(transport);
    await assert.rejects(adapter.preview(proposal()), badToken ? /token must be a safe integer/ : /Preview response does not match/);
    assert.equal(calls.filter(call => call.command === "proposal.cancel").length, badToken ? 0 : 1);
  }
});

test("inspection refuses a project changed between project and sequence snapshots", async () => {
  let reads = 0;
  const {transport} = fixture(command => command === "project.inspect" ? {revision: ++reads === 1 ? 4 : 5, activeSequence: 7} : undefined);
  const adapter = await ShwayAdapter.connect(transport);
  await assert.rejects(adapter.inspect(), code("stale"));
});

test("selection cannot target a missing clip and frame seeking refuses fractions", async () => {
  const {transport, calls} = fixture();
  const adapter = await ShwayAdapter.connect(transport);
  await assert.rejects(adapter.select([999]), code("invalid"));
  assert(!calls.some(call => call.command === "timeline.select"));
  assert.throws(() => adapter.seekFrame(1.2), code("invalid"));
  await adapter.seekFrame(42);
  assert.deepEqual(calls.at(-1), {command: "playhead.set", params: {frame: 42}});
});

test("bounded previews render typed pixels; unsafe tokens and invalid pixel buffers fail", async () => {
  const {transport, calls} = fixture();
  const adapter = await ShwayAdapter.connect(transport);
  const result = await adapter.previewFrame(9, 0, 128);
  assert.deepEqual(result.rgba, Uint8Array.of(40, 80, 120, 255));
  await assert.rejects(adapter.previewFrame(Number.MAX_SAFE_INTEGER + 1, 0), code("invalid"));
  await assert.rejects(adapter.previewFrame(9, 0, 257), code("invalid"));
  assert.equal(calls.length, 1);
  const broken = fixture(command => command === "proposal.render" ? {width: 1, height: 1, rgba: [0, 0, 0, 256]} : undefined);
  await assert.rejects((await ShwayAdapter.connect(broken.transport)).previewFrame(9, 0), code("response"));
});

test("only explicit pending responses retry until complete pixels arrive", async () => {
  let reads = 0;
  const {transport, calls} = fixture(command => command === "proposal.render" && ++reads === 1 ? {pending: true} : undefined);
  const adapter = await ShwayAdapter.connect(transport);
  assert.deepEqual((await adapter.previewFrame(9, 0)).rgba, Uint8Array.of(40, 80, 120, 255));
  assert.equal(calls.length, 2);
  const malformed = fixture(command => command === "proposal.render" ? {} : undefined);
  await assert.rejects((await ShwayAdapter.connect(malformed.transport)).previewFrame(9, 0));
  assert.equal(malformed.calls.length, 1);
  const ambiguous = fixture(command => command === "proposal.render" ? {pending: true, rgba: []} : undefined);
  await assert.rejects((await ShwayAdapter.connect(ambiguous.transport)).previewFrame(9, 0));
  assert.equal(ambiguous.calls.length, 1);
});

test("stale-token failure after pending propagates immediately without more retries", async () => {
  let reads = 0;
  const stale = new Error("proposal.render: stale token");
  const {transport, calls} = fixture(command => {
    if (command === "proposal.render") {if (++reads === 1) return {pending: true}; throw stale;}
  });
  const adapter = await ShwayAdapter.connect(transport);
  await assert.rejects(adapter.previewFrame(9, 0), error => error === stale);
  assert.equal(calls.length, 2);
});

test("pending preview expires at its bounded deadline with an actionable error", async () => {
  const {transport, calls} = fixture(command => command === "proposal.render" ? {pending: true} : undefined);
  const adapter = await ShwayAdapter.connect(transport);
  const started = Date.now();
  await assert.rejects(adapter.previewFrame(9, 0), error => error instanceof AdapterError && /within 5 seconds; retry/.test(error.message));
  assert(Date.now() - started < 6500, "retry deadline must stay bounded");
  assert(calls.length > 1 && calls.length <= 101, "pending responses must be rate limited");
});

test("preview lifecycle uses token-scoped engine commands and returns undo labels", async () => {
  const {transport, calls} = fixture();
  const adapter = await ShwayAdapter.connect(transport);
  assert.equal((await adapter.preview(proposal())).token, 9);
  assert.equal((await adapter.inspectPreview(9)).token, 9);
  assert.deepEqual(await adapter.cancel(9), {cancelled: true});
  assert.deepEqual(await adapter.commit(9), {committed: true, revision: 5, label: "Shorten take"});
  assert.deepEqual(await adapter.undo(), {undone: "Shorten take"});
  assert(calls.filter(call => ["proposal.inspect", "proposal.cancel", "proposal.commit"].includes(call.command)).every(call => JSON.stringify(call.params) === '{"token":9}'));
  assert.equal("execute" in adapter, false);
});

test("assembly sends one exact timeline.place step and rejects hostile ranges before dispatch", async () => {
  const {transport, calls} = fixture();
  const adapter = await ShwayAdapter.connect(transport);
  const ranges = [{item: 31, sourceIn: 0, sourceOut: 42336000000}, {item: 32, sourceIn: 84672000000, sourceOut: 127008000000}];
  const input = {expectedRevision: 4, sequence: 7, label: "Shorten take", ranges};
  const preview = adapter.assemble(input);
  ranges[0].item = 99;
  assert.equal((await preview).token, 9);
  assert.deepEqual(calls.find(call => call.command === "proposal.preview")?.params, {expectedRevision: 4, sequence: 7, label: "Shorten take",
    steps: [{command: "timeline.place", params: {ranges: [{item: 31, sourceIn: 0, sourceOut: 42336000000}, ranges[1]]}}]});
  const before = calls.length;
  const range = {item: 31, sourceIn: 0, sourceOut: 10};
  for (const bad of [
    [], new Array(33).fill(range), [{...range, sourceOut: 0}], [{...range, sourceIn: -1}], [{...range, sourceOut: 1.5}],
    [{...range, sourceOut: Number.MAX_SAFE_INTEGER + 1}], [{...range, item: 0}], [{...range, seconds: 1}], [null],
  ]) await assert.rejects(adapter.assemble({...input, ranges: bad as typeof ranges}), code("invalid"));
  await assert.rejects(adapter.assemble({...input, autoplay: true} as typeof input), code("invalid"));
  assert.equal(calls.length, before);
});

test("remove and move steps pass exact explicit IDs and reject hostile shapes before dispatch", async () => {
  const {transport, calls} = fixture();
  const adapter = await ShwayAdapter.connect(transport);
  const remove = {command: "timeline.remove", params: {clips: [21, 23]}} as const;
  const move = {command: "timeline.move", params: {clip: 23, anchor: 21, position: "before"}} as const;
  const trim = proposal().steps[0];
  await adapter.preview({...proposal(), steps: [move, trim, remove]});
  assert.deepEqual(calls.find(call => call.command === "proposal.preview")?.params.steps, [move, trim, remove]);
  const before = calls.length;
  const steps = (step: unknown) => ({...proposal(), steps: [step]}) as unknown as EditProposal;
  for (const bad of [
    {command: "timeline.remove", params: {clips: []}},
    {command: "timeline.remove", params: {clips: [21, 21]}},
    {command: "timeline.remove", params: {clips: new Array(33).fill(0).map((_, i) => i + 1)}},
    {command: "timeline.remove", params: {clips: [0]}},
    {command: "timeline.remove", params: {clips: [21], ripple: false}},
    {command: "timeline.remove", params: {clip: 21}},
    {command: "timeline.move", params: {clip: 21, anchor: 21, position: "after"}},
    {command: "timeline.move", params: {clip: 21, anchor: 23, position: "over"}},
    {command: "timeline.move", params: {clip: 21, anchor: 1.5, position: "after"}},
    {command: "timeline.move", params: {clip: 21, position: "after"}},
    {command: "timeline.move", params: {clip: 21, anchor: 23, position: "after", time: 0}},
  ]) await assert.rejects(adapter.preview(steps(bad)), code("invalid"));
  // Each move references two clips toward the 32-target bound.
  await assert.rejects(adapter.preview({...proposal(), steps: [...new Array(15).fill(move), {command: "timeline.remove", params: {clips: [21, 23, 24]}}]}), code("invalid"));
  assert.equal(calls.length, before);
});

test("transition steps pass the allowlisted effect and reject hostile shapes before dispatch", async () => {
  const {transport, calls} = fixture();
  const adapter = await ShwayAdapter.connect(transport);
  const move = {command: "timeline.move", params: {clip: 23, anchor: 21, position: "after"}} as const;
  const join = {command: "sequence.applyVideoTransition", params: {clip: 23, effect: "push", edge: "in", direction: "left"}} as const;
  await adapter.preview({...proposal(), steps: [move, join]});
  assert.deepEqual(calls.find(call => call.command === "proposal.preview")?.params.steps, [move, join]);
  const before = calls.length;
  const steps = (step: unknown) => ({...proposal(), steps: [step]}) as unknown as EditProposal;
  for (const params of [
    {clip: 23, effect: "cross_dissolve", edge: "in"}, {clip: 23, effect: "split", edge: "middle"}, {clip: 0, effect: "split", edge: "in"},
    {clip: 23, effect: "split", edge: "in", direction: "left"}, {clip: 23, effect: "push", edge: "in", direction: "up"},
    {clip: 23, effect: "split", edge: "in", frames: 30}, {effect: "split", edge: "in"},
  ]) await assert.rejects(adapter.preview(steps({command: "sequence.applyVideoTransition", params})), code("invalid"));
  assert.equal(calls.length, before);
});

test("alignRange widens word-boundary ticks to the engine's exact frame grid", () => {
  const f24 = 10584000000, fps24 = {num: 24, den: 1};
  // 0.9 s = 21.6 frames: In floors to 21, Out ceils to 22.
  assert.deepEqual(alignRange({item: 3, sourceIn: 228614400000, sourceOut: 228614400000 + 1}, fps24), {item: 3, sourceIn: 21 * f24, sourceOut: 22 * f24});
  assert.deepEqual(alignRange({item: 3, sourceIn: 2 * f24, sourceOut: 5 * f24}, fps24), {item: 3, sourceIn: 2 * f24, sourceOut: 5 * f24});
  // 29.97: frame 30 starts at ceil(30 * 254016000000 * 1001 / 30000); one tick later rounds out to frame 31.
  const ntsc = {num: 30000, den: 1001};
  assert.deepEqual(alignRange({item: 3, sourceIn: 254270016000, sourceOut: 254270016001}, ntsc), {item: 3, sourceIn: 254270016000, sourceOut: 254270016000 + 8475667200});
  for (const [range, rate] of [
    [{item: 3, sourceIn: -1, sourceOut: f24}, fps24], [{item: 3, sourceIn: 0, sourceOut: 1.5}, fps24], [{item: 0, sourceIn: 0, sourceOut: f24}, fps24],
    [{item: 3, sourceIn: f24, sourceOut: f24}, fps24], [{item: 3, sourceIn: 0, sourceOut: f24}, {num: 0, den: 1}], [{item: 3, sourceIn: 0, sourceOut: f24}, {num: 24, den: 0}],
    [{item: 3, sourceIn: 0, sourceOut: Number.MAX_SAFE_INTEGER}, fps24],
  ] as const) assert.throws(() => alignRange(range, rate), code("invalid"));
});

test("export is constrained to H264/AAC and failed completed jobs retain error evidence", async () => {
  const {transport, calls} = fixture();
  const adapter = await ShwayAdapter.connect(transport);
  await assert.rejects(adapter.export({path: "/exports/demo.mp4", format: "anything"} as {path: string}), code("invalid"));
  await assert.rejects(adapter.export({path: "/projects/demo.mp4"}), code("invalid"));
  assert.equal(calls.length, 0);
  assert.deepEqual(await adapter.export({path: "/exports/demo.mp4"}), {job: 2, path: "/exports/demo.mp4"});
  assert.deepEqual(calls[0].params, {path: "/exports/demo.mp4", format: "h264", range: "entire", audio: true, bitrateKbps: 4000});
  const [job] = await adapter.jobs();
  assert.equal(job.finished, true);
  assert.deepEqual(job.result, {error: "Disk full"});
});

test("gesture transport maps to playback, step, seek, edit navigation and cut", async () => {
  const {transport, calls} = fixture();
  transport.commands = async () => [...capabilities, "playhead.step", "playhead.nextEdit", "playhead.prevEdit", "sequence.addEdit"].map(id => ({id}));
  transport.request = async (method, params = {}) => {calls.push({command: method, params}); return method === "ui.inspect" ? {playhead: 12345} : {};};
  const adapter = await ShwayAdapter.connect(transport);
  await adapter.shuttle(-2);
  await adapter.togglePlay();
  await adapter.stepFrames(-3);
  assert.equal(await adapter.playhead(), 12345);
  await adapter.seekTicks(12345);
  await adapter.nextEdit();
  await adapter.prevEdit();
  await adapter.cut();
  assert.deepEqual(calls.map(c => [c.command, c.params]), [
    ["ui.playback", {action: "play", speed: -2}], ["ui.playback", {action: "toggle"}], ["playhead.step", {frames: -3}],
    ["ui.inspect", {}], ["playhead.set", {time: 12345}], ["playhead.nextEdit", {}], ["playhead.prevEdit", {}], ["sequence.addEdit", {}],
  ]);
});

test("hostile gesture values never reach the engine", async () => {
  const {transport, calls} = fixture();
  transport.commands = async () => [...capabilities, "playhead.step"].map(id => ({id}));
  const adapter = await ShwayAdapter.connect(transport);
  for (const speed of [0, NaN, Infinity, -9, 8.5, "2" as unknown as number]) assert.throws(() => adapter.shuttle(speed), code("invalid"));
  for (const frames of [0, 1001, -1001, 1.5, NaN]) assert.throws(() => adapter.stepFrames(frames), code("invalid"));
  for (const time of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => adapter.seekTicks(time), code("invalid"));
  assert.equal(calls.length, 0);
  transport.request = async () => ({playhead: -5});
  await assert.rejects(adapter.playhead(), code("invalid"));
});

test("cut and edit navigation require the engine to offer them", async () => {
  const {transport} = fixture();
  const adapter = await ShwayAdapter.connect(transport);
  assert.throws(() => adapter.cut(), code("capability"));
  assert.throws(() => adapter.nextEdit(), code("capability"));
});
