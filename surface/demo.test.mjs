// Demo page logic. Run: node --test surface/demo.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHoldToTalk, readBrief, createProposals, loadHook } from "./demo.mjs";

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
  assert.deepEqual(p.pending, { token: 2, label: "B" });
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
