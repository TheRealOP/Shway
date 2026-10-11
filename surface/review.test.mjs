// node --test surface/review.test.mjs — the review remote against a recording fake assistant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createReview, noteText } from "./review.mjs";

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
  assert.equal(await r.gesture({ type: "double-tap" }), "Failed: editor down");
  assert.equal(await r.cancel(), "Resumed.");
});
