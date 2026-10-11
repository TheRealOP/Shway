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
    { type: "swipe", t: 6, direction: "left" }, { type: "chop", t: 7 },
    { type: "draw-toggle", t: 8, drawing: true }, { type: "double-tap", t: 9 }, { type: "pointer", t: 10, x: 0.5, y: 0.5 },
  ]) await send(e); // real events arrive frames apart
  // Ink events (draw-toggle, pen, pointer) belong to the camera page; double tap no longer toggles playback.
  assert.deepEqual(calls, [
    ["playhead"], ["shuttle", 2], ["stop"], ["stepFrames", -1], ["nextEdit"], ["prevEdit"], ["cut"],
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
  await send({ type: "swipe", t: 1, direction: "right" });
  assert.deepEqual(errors, [["chop", "cut failed"]]);
  assert.deepEqual(calls.at(-1), ["nextEdit"]);
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

test("fist: pause stops and remembers the playhead; slide seeks relative to it, clamped at 0; cancel goes back", async () => {
  const TPS = 254016000000;
  const { adapter, calls } = fake({ playhead: 10 * TPS });
  const send = createBridge(adapter);
  send({ type: "pause", t: 0 });
  await send({ type: "slide", t: 1, seconds: 2.5 });
  await send({ type: "slide", t: 2, seconds: -30 });
  await send({ type: "cancel", t: 3 });
  assert.deepEqual(calls, [["stop"], ["playhead"], ["seekTicks", 12.5 * TPS], ["seekTicks", 0], ["seekTicks", 10 * TPS]]);
});

test("queued slides collapse to the latest; slides after release or without a pause do nothing", async () => {
  const TPS = 254016000000;
  const { adapter, calls } = fake({ slow: 5, playhead: TPS });
  const send = createBridge(adapter);
  send({ type: "pause", t: 0 });
  for (const seconds of [0.05, 0.1, 0.15, 0.2]) send({ type: "slide", t: seconds, seconds });
  await send({ type: "noop" });
  assert.deepEqual(calls, [["stop"], ["playhead"], ["seekTicks", 1.2 * TPS]]);
  send({ type: "release", t: 1 });
  await send({ type: "slide", t: 2, seconds: 1 });
  assert.equal(calls.length, 3, "dropped where it was released");
  const fresh = fake();
  await createBridge(fresh.adapter)({ type: "slide", t: 0, seconds: 1 });
  assert.deepEqual(fresh.calls, []);
});
