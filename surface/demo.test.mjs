// Demo page logic. Run: node --test surface/demo.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHoldToTalk, readBrief, createProposals, loadHook, readTribeEvent, createTribeGate, clipAt, tribeCorrection } from "./demo.mjs";

const armed = { state: "Armed", pinching: true };
test("a still pinch talks after the hold; releasing finishes, twisting aborts", () => {
  const h = createHoldToTalk({ holdMs: 800 });
  assert.equal(h.step(0, armed), null);
  assert.equal(h.step(799, armed), null);
  assert.equal(h.step(800, armed), "talk");
  assert.equal(h.step(900, armed), null); // once
  assert.equal(h.step(950, { state: "Idle", pinching: false }), "done");
  assert.equal(h.step(1000, armed), null); // a fresh hold restarts the clock
  assert.equal(h.step(1900, armed), "talk");
  assert.equal(h.step(1950, { state: "Adjusting", pinching: true }), "abort");
  // Space-held engagement (no pinch) and a short pinch never talk.
  assert.equal(h.step(3000, { state: "Armed", pinching: false }), null);
  assert.equal(h.step(9000, { state: "Armed", pinching: false }), null);
  assert.equal(h.step(9100, armed), null);
  assert.equal(h.step(9200, { state: "Idle", pinching: false }), null);
});

test("brief needs message, audience, feeling, a sane duration and a script", () => {
  const ok = { message: " Launch ", audience: "makers", feeling: "warm", duration: "30", script: "Hi.\n\n Bye. " };
  assert.deepEqual(readBrief(ok), { brief: { message: "Launch", audience: "makers", feeling: "warm", durationSeconds: 30 }, script: ["Hi.", "Bye."] });
  for (const bad of [{ message: "" }, { audience: " " }, { feeling: undefined }, { duration: "4" }, { duration: "601" },
    { duration: "2.5" }, { duration: "abc" }, { script: "\n \n" }, { message: "x".repeat(501) }, { script: "a\n".repeat(201) }]) {
    assert.ok(readBrief({ ...ok, ...bad }).error, JSON.stringify(bad));
  }
});

function fakeAdapter(fail = "") {
  const calls = [];
  const go = async (name, v, r) => { calls.push([name, v]); if (fail === name) throw new Error(`${name} failed`); return r; };
  return { calls, adapter: {
    commit: (t) => go("commit", t, { revision: 7, label: "Replace take" }),
    cancel: (t) => go("cancel", t, { cancelled: true }),
    undo: () => go("undo", null, { undone: "Replace take" }),
  } };
}

test("accept commits, reject cancels, a newer proposal discards the older, undo undoes", async () => {
  const { adapter, calls } = fakeAdapter();
  const seen = [];
  const p = createProposals(adapter, (s) => seen.push(s));
  await p.show({ token: 1, label: "A" });
  await p.show({ token: 2, label: "B" });
  assert.deepEqual(p.pending, { token: 2, label: "B", source: "creator" });
  await p.accept();
  assert.equal(p.pending, null);
  await p.show({ token: 3, label: "C" });
  await p.reject();
  await p.undo();
  await p.accept(); // nothing pending: no call
  assert.deepEqual(calls, [["cancel", 1], ["commit", 2], ["cancel", 3], ["undo", null]]);
  assert.match(seen.at(-1).status, /Nothing to accept/);
  await p.show({ label: "no token" });
  assert.match(seen.at(-1).status, /no preview token/);
});

test("a failed commit stays pending so it can be rejected; calls never overlap", async () => {
  const { adapter, calls } = fakeAdapter("commit");
  const seen = [];
  const p = createProposals(adapter, (s) => seen.push(s));
  await p.show({ token: 5, label: "X" });
  await p.accept();
  assert.match(seen.at(-1).status, /commit failed/);
  assert.equal(p.pending?.token, 5);
  const a = p.reject(), b = p.reject(); // second press while busy is ignored
  await Promise.all([a, b]);
  assert.deepEqual(calls, [["commit", 5], ["cancel", 5]]);
});

test("a missing hook module reports not available", async () => {
  assert.deepEqual(await loadHook("./no-such-module.js", ["f"]), { error: "not available yet" });
  assert.match((await loadHook("./demo.mjs", ["nope"])).error, /lacks nope/);
  assert.ok((await loadHook("./demo.mjs", ["readBrief"])).module);
});

const EVENT = { version: 1, id: "e1", kind: "below-reference", sequence: 7, revision: 12, renderId: "sha256:ab",
  range: { start: 100, end: 300 }, score: 0.4, reference: "ref-1@3", model: "tribev2@ckpt" };
const NOW = { sequence: 7, revision: 12, pending: false, active: false };

test("TRIBE events: malformed fields are refused; unknown fields are dropped", () => {
  assert.deepEqual(readTribeEvent({ ...EVENT, extra: [1] }), EVENT);
  for (const bad of [{ version: 2 }, { id: "" }, { id: "x".repeat(129) }, { kind: "engaging" }, { sequence: 0 }, { revision: -1 },
    { revision: 1.5 }, { renderId: 3 }, { range: { start: 5, end: 5 } }, { range: { start: -1, end: 5 } }, { range: null },
    { score: 1.01 }, { score: NaN }, { reference: "" }, { model: undefined }]) {
    assert.equal(readTribeEvent({ ...EVENT, ...bad }), null, JSON.stringify(bad));
  }
  assert.equal(readTribeEvent(null), null);
});

test("TRIBE gate: stale and duplicate events drop; the creator's activity defers without forgetting", () => {
  const g = createTribeGate();
  assert.deepEqual(g.check({ ...EVENT, revision: 11 }, NOW), { drop: "stale" });
  assert.deepEqual(g.check({ ...EVENT, sequence: 8 }, NOW), { drop: "stale" });
  assert.deepEqual(g.check({ kind: "x" }, NOW), { drop: "malformed" });
  assert.deepEqual(g.check(EVENT, { ...NOW, pending: true }), { drop: "busy" });
  assert.deepEqual(g.check(EVENT, { ...NOW, active: true }), { drop: "busy" });
  assert.deepEqual(g.check(EVENT, NOW), { event: EVENT }); // busy was not remembered
  assert.deepEqual(g.check(EVENT, NOW), { drop: "duplicate" });
  assert.deepEqual(g.check({ ...EVENT, id: "e2" }, NOW), { drop: "duplicate" }); // same render and range
  assert.ok("event" in g.check({ ...EVENT, id: "e3", range: { start: 300, end: 400 } }, NOW));
});

test("clipAt picks the top clip under the range middle; tribeCorrection never claims a measurement", () => {
  const seq = { video: [{ items: [{ clip: 1, start: 0, duration: 200 }, { clip: 2, start: 200, duration: 200 }] }, { items: [{ clip: 9, start: 350, duration: 50 }] }] };
  assert.equal(clipAt(seq, { start: 100, end: 300 }), 2); // middle 200 starts clip 2
  assert.equal(clipAt(seq, { start: 0, end: 100 }), 1);
  assert.equal(clipAt(seq, { start: 360, end: 380 }), 9);
  assert.equal(clipAt(seq, { start: 500, end: 600 }), null);
  const text = tribeCorrection(EVENT, "warm");
  assert.match(text, /average-viewer/); assert.match(text, /not a measurement/); assert.match(text, /answer -1/);
});

test("a TRIBE suggestion never displaces a pending proposal; a creator proposal displaces a suggestion", async () => {
  const { adapter, calls } = fakeAdapter();
  const seen = [];
  const p = createProposals(adapter, (s) => seen.push(s));
  await p.show({ token: 1, label: "Mine" });
  await p.show({ token: 2, label: "Suggested", source: "tribe" });
  assert.equal(p.pending?.token, 1);
  assert.match(seen.at(-1).status, /Suggestion skipped/);
  await p.reject();
  await p.show({ token: 3, label: "Suggested", source: "tribe" });
  assert.deepEqual(p.pending, { token: 3, label: "Suggested", source: "tribe" });
  await p.show({ token: 4, label: "Mine again" });
  assert.equal(p.pending?.token, 4);
  assert.deepEqual(calls, [["cancel", 2], ["cancel", 1], ["cancel", 3]]);
});
