// Bridge tests with a fake adapter. Run: node --test surface/gestures/bridge.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBridge } from "./bridge.mjs";

function fake({ failOn = "", slow = 0, playhead = 1000 } = {}) {
  const calls = [];
  const call = (name, ...args) => async () => {
    if (slow) await new Promise((r) => setTimeout(r, slow));
    calls.push([name, ...args]);
    if (name === failOn) throw new Error(`${name} failed`);
    return name === "playhead" ? playhead : {};
  };
  const adapter = {
    shuttle: (s) => call("shuttle", s)(), stop: () => call("stop")(), togglePlay: () => call("togglePlay")(),
    stepFrames: (n) => call("stepFrames", n)(), playhead: () => call("playhead")(), seekTicks: (t) => call("seekTicks", t)(),
    nextEdit: () => call("nextEdit")(), prevEdit: () => call("prevEdit")(), cut: () => call("cut")(),
  };
  return { adapter, calls };
}

test("each gesture maps to its editor call, in order", async () => {
  const { adapter, calls } = fake();
  const send = createBridge(adapter);
  for (const e of [
    { type: "engage", t: 0 }, { type: "shuttle", t: 1, rate: 2 }, { type: "shuttle", t: 2, rate: 0 },
    { type: "release", t: 3 }, { type: "step", t: 4, frames: -1 }, { type: "swipe", t: 5, direction: "right" },
    { type: "swipe", t: 6, direction: "left" }, { type: "chop", t: 7 }, { type: "double-tap", t: 8 },
  ]) await send(e); // real events arrive frames apart
  assert.deepEqual(calls, [
    ["playhead"], ["shuttle", 2], ["stop"], ["stepFrames", -1], ["nextEdit"], ["prevEdit"], ["cut"], ["togglePlay"],
  ]);
});

test("cancel restores the playhead captured at engage", async () => {
  const { adapter, calls } = fake({ playhead: 4242 });
  const send = createBridge(adapter);
  send({ type: "engage", t: 0 });
  send({ type: "shuttle", t: 1, rate: 4 });
  send({ type: "shuttle", t: 2, rate: 0 });
  await send({ type: "cancel", t: 3 });
  assert.deepEqual(calls.at(-1), ["seekTicks", 4242]);
});

test("cancel after release or tracking loss does not jump back", async () => {
  for (const end of ["release", "tracking-lost"]) {
    const { adapter, calls } = fake();
    const send = createBridge(adapter);
    send({ type: "engage", t: 0 });
    send({ type: end, t: 1 });
    await send({ type: "cancel", t: 2 });
    assert.ok(!calls.some(([n]) => n === "seekTicks"), end);
  }
});

test("queued shuttle updates collapse to the latest rate", async () => {
  const { adapter, calls } = fake({ slow: 5 });
  const send = createBridge(adapter);
  send({ type: "step", t: 0, frames: 1 }); // occupies the queue
  for (const rate of [0.5, 1, 2, 4]) send({ type: "shuttle", t: rate, rate });
  await send({ type: "noop" });
  assert.deepEqual(calls, [["stepFrames", 1], ["shuttle", 4]]);
});

test("a failing call is reported and later calls still run", async () => {
  const { adapter, calls } = fake({ failOn: "cut" });
  const errors = [];
  const send = createBridge(adapter, { onError: (err, e) => errors.push([e.type, err.message]) });
  send({ type: "chop", t: 0 });
  await send({ type: "double-tap", t: 1 });
  assert.deepEqual(errors, [["chop", "cut failed"]]);
  assert.deepEqual(calls.at(-1), ["togglePlay"]);
});

test("a failed playhead read leaves cancel harmless", async () => {
  const { adapter, calls } = fake({ failOn: "playhead" });
  const send = createBridge(adapter, { onError: () => {} });
  send({ type: "engage", t: 0 });
  await send({ type: "cancel", t: 1 });
  assert.ok(!calls.some(([n]) => n === "seekTicks"));
});

test("unknown or malformed events are ignored", async () => {
  const { adapter, calls } = fake();
  const send = createBridge(adapter);
  for (const e of [null, undefined, {}, { type: "explode" }, 7]) await send(/** @type {any} */ (e));
  assert.deepEqual(calls, []);
});
