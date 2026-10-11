// node --test surface/review.test.mjs — the review remote against a recording fake assistant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createInk, createInkSender, createReview, noteText } from "./review.mjs";

const M = { revision: 3, playhead: 254016000000, clip: 7 };
function fake(fail = {}) {
  const calls = [];
  let release = null;
  const post = async (path, body) => {
    calls.push([path, body]);
    if (path === "/review/stop" && fail.slowStop) await new Promise((r) => (release = r));
    if (fail[path]) throw new Error(fail[path]);
    return path === "/review/stop" ? { moment: M } : path === "/review/note" ? { reply: "Trimming it.", pending: { token: 1 } } : { ok: true };
  };
  return { calls, post, release: () => release?.() };
}

test("noteText: a leading stop is the stop, not the note", () => {
  assert.equal(noteText("Stop. This bit drags"), "This bit drags");
  assert.equal(noteText("  stop!  "), "");
  assert.equal(noteText("don't stop here"), "don't stop here");
  assert.equal(noteText("stopwatch shot is too long"), "stopwatch shot is too long");
  assert.equal(noteText(null), "");
});

test("stop then note: the note carries the captured moment and the gestures' types", async () => {
  const f = fake(), r = createReview(f.post);
  assert.match(await r.stop(), /Stopped at 1\.00 s, clip 7 \(rev 3\)/);
  assert.match(await r.note("stop, this pause is too long", [{ type: "step", frames: 3, t: 1 }, { nope: 1 }]), /Trimming it\. Accept or reject/);
  assert.deepEqual(f.calls[1], ["/review/note", { moment: M, transcript: "this pause is too long", gestures: [{ type: "step" }] }]);
});

test("saying only 'stop' stays stopped; no note without a captured moment", async () => {
  const f = fake(), r = createReview(f.post);
  assert.match(await r.note("anything"), /No moment captured/);
  await r.stop();
  assert.match(await r.note("Stop."), /Hold to talk to explain, or Resume/);
  assert.deepEqual(f.calls.map((c) => c[0]), ["/review/stop"]);
});

test("transport events are serialized behind the stop; chop goes to /review/cut; others dropped", async () => {
  const f = fake({ slowStop: true }), r = createReview(f.post);
  r.stop();
  const step = r.gesture({ type: "step", frames: 2, t: 9 });
  r.gesture({ type: "pinch-ratio" });
  await new Promise((ok) => setTimeout(ok, 10));
  assert.deepEqual(f.calls.map((c) => c[0]), ["/review/stop"]); // the step waits for the stop
  f.release();
  await step;
  await r.gesture({ type: "chop" });
  await r.gesture({ type: "shuttle", rate: 2, extra: "x" });
  assert.deepEqual(f.calls.slice(1), [["/review/transport", { event: { type: "step", frames: 2 } }], ["/review/cut", undefined],
    ["/review/transport", { event: { type: "shuttle", rate: 2 } }]]);
});

test("failures become status lines and the queue carries on", async () => {
  const f = fake({ "/review/transport": "editor down" }), r = createReview(f.post);
  assert.equal(await r.gesture({ type: "pause" }), "Failed: editor down");
  assert.equal(await r.cancel(), "Resumed.");
});

test("ink: pen strokes from pointer events; a new drawing replaces the sketch; cancel clears; caps 20 × 500", () => {
  const ink = createInk();
  const ev = (type, extra = {}) => ink.event({ type, t: 0, ...extra });
  ev("pointer", { x: 0.1, y: 0.1 });
  ev("draw-toggle", { drawing: true });
  ev("pen-down"); ev("pointer", { x: 0.2, y: 0.2 }); ev("pen-up");
  ev("pointer", { x: 0.5, y: 0.5 }); // pen up: moves the dot only
  ev("pen-down"); ev("pointer", { x: 0.6, y: 0.6 });
  assert.deepEqual(ink.state(), { pointer: [0.6, 0.6], strokes: [[[0.1, 0.1], [0.2, 0.2]], [[0.5, 0.5], [0.6, 0.6]]], drawing: true });
  ev("draw-toggle", { drawing: false });
  assert.equal(ink.state().strokes.length, 2, "a finished sketch stays");
  assert.equal(ink.visible(false), true);
  assert.equal(ink.state().pointer, null);
  assert.equal(ink.visible(false), false, "no change, no send");
  ev("draw-toggle", { drawing: true });
  assert.deepEqual(ink.state().strokes, [], "a new drawing starts clean");
  for (let k = 0; k < 25; k++) { ev("pen-down"); for (let i = 0; i < 600; i++) ev("pointer", { x: k / 100, y: i / 600 }); ev("pen-up"); }
  const s = ink.state().strokes;
  assert.equal(s.length, 20);
  assert.ok(s.every((p) => p.length === 500));
  assert.equal(s[0][1][0], 0.05);
  ev("cancel");
  assert.deepEqual(ink.state(), { pointer: [0.24, 599 / 600], strokes: [], drawing: false });
});

test("ink sender: ≤ 30 Hz, one in flight, latest wins, failures reported", async () => {
  const posts = [], errors = [];
  let open;
  const post = async (path, body) => { posts.push([path, body.n]); if (body.n === 1) await new Promise((r) => (open = r)); if (body.n === 9) throw new Error("down"); };
  const send = createInkSender(post, { minGapMs: 20, onError: (e) => errors.push(e.message) });
  const first = send({ n: 1 });
  for (const n of [2, 3, 4]) send({ n });
  assert.deepEqual(posts, [["/ink", 1]]);
  open();
  await first;
  assert.deepEqual(posts, [["/ink", 1], ["/ink", 4]], "stale 2 and 3 dropped");
  const t0 = performance.now();
  await send({ n: 9 });
  assert.ok(performance.now() - t0 >= 15, "rate-limited");
  assert.deepEqual(errors, ["down"]);
});

test("slides queue latest-wins behind a slow call; pause/slide carry their payloads", async () => {
  const f = fake({ slowStop: true }), r = createReview(f.post);
  r.stop();
  r.gesture({ type: "pause", t: 1 });
  for (const seconds of [0.05, 0.1, 0.15]) r.gesture({ type: "slide", seconds, t: 2 });
  await new Promise((ok) => setTimeout(ok, 10)); // the stop has reached the (held) fake
  f.release();
  await r.gesture({ type: "release", t: 3 });
  assert.deepEqual(f.calls.slice(1).map((c) => c[1].event), [{ type: "pause" }, { type: "slide", seconds: 0.15 }, { type: "release" }]);
  assert.equal(await r.gesture({ type: "draw-toggle", drawing: true }), "", "ink events don't go to transport");
  assert.equal(f.calls.length, 4);
});
