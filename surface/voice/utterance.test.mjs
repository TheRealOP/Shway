// Replay tests for push-to-talk utterances. Run: node --test surface/voice/utterance.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createVoice } from "./utterance.mjs";

const ctx = { revision: 7, selection: [3], target: 3, playhead: 254016000000, gesture: "Idle" };

test("hold and release the key yields one utterance with the start-time context", () => {
  const v = createVoice();
  const live = structuredClone(ctx);
  assert.deepEqual(v.key(1000, "KeyV", true, live), { type: "recording", id: "u1", t: 1000 });
  assert.equal(v.key(1100, "KeyV", true, live), null, "key repeat is ignored");
  live.selection = [9]; // selection changes while speaking must not leak into the snapshot
  const e = v.key(2500, "KeyV", false);
  assert.equal(e?.type, "utterance");
  const u = /** @type {any} */ (e).utterance;
  assert.deepEqual([u.id, u.source, u.startT, u.endT, u.capped, u.audio, u.transcript], ["u1", "key", 1000, 2500, false, null, null]);
  assert.deepEqual(u.context, ctx);
  assert.equal(v.view().recording, false);
  assert.equal(v.key(2600, "KeyX", true), null, "other keys do nothing");
});

test("configurable key", () => {
  const v = createVoice({ key: "Backquote" });
  assert.equal(v.key(0, "KeyV", true), null);
  assert.equal(v.key(0, "Backquote", true)?.type, "recording");
});

test("too-short hold is rejected", () => {
  const v = createVoice();
  v.start(0, ctx, "gesture");
  assert.deepEqual(v.stop(299), { type: "rejected", reason: "too-short", t: 299 });
  assert.equal(v.view().recording, false);
  v.start(400);
  assert.equal(v.stop(700).type, "utterance", "exactly minMs is accepted");
});

test("too-long recording is capped by tick and by a late stop", () => {
  const v = createVoice({ maxMs: 5000 });
  v.start(0, ctx, "key");
  assert.equal(v.tick(4999), null);
  const e = /** @type {any} */ (v.tick(5200));
  assert.equal(e.type, "utterance");
  assert.deepEqual([e.utterance.endT, e.utterance.capped], [5000, true]);
  assert.equal(v.key(9000, "KeyV", false), null, "release after the cap does nothing");
  v.start(9500, ctx, "key");
  v.gesture({ type: "swipe", t: 15000, direction: "left" }); // after the 14500 cap
  assert.deepEqual(/** @type {any} */ (v.tick(15100)).utterance.gestures, [], "gestures past the cap are excluded");
  v.start(16000);
  const late = /** @type {any} */ (v.stop(99999));
  assert.deepEqual([late.utterance.endT, late.utterance.capped], [21000, true]);
});

test("cancel discards the recording", () => {
  const v = createVoice();
  v.start(0, ctx);
  assert.deepEqual(v.cancel(800), { type: "cancelled", id: "u1", t: 800 });
  assert.equal(v.stop(900).type, "rejected");
  assert.equal(v.cancel(1000).type, "rejected");
});

test("gestures associate within [start - preMs, end] only", () => {
  const v = createVoice({ preMs: 1000 });
  v.gesture({ type: "swipe", t: 100, direction: "left" }); // too early
  v.gesture({ type: "chop", t: 1500 });                    // 500 ms before start
  v.start(2000, ctx);
  v.gesture({ type: "swipe", t: 2500, direction: "right" });
  const u = /** @type {any} */ (v.stop(3000)).utterance;
  v.gesture({ type: "double-tap", t: 3100 });               // after release
  assert.deepEqual(u.gestures.map((/** @type {any} */ g) => g.t), [1500, 2500]);
  assert.equal(u.gestures.length, 2, "later gestures don't mutate a finished utterance");
});

test("gesture buffer is bounded", () => {
  const v = createVoice({ maxGestures: 4 });
  v.start(0);
  for (let t = 1; t <= 100; t++) v.gesture({ type: "step", t });
  assert.equal(/** @type {any} */ (v.stop(500)).utterance.gestures.length, 4);
});

test("nothing is captured without push-to-talk", () => {
  const v = createVoice();
  // Playback audio or stray stops/ticks while idle never produce an utterance.
  assert.equal(v.stop(1000).type, "rejected");
  assert.equal(v.tick(20000), null);
  assert.equal(v.key(1000, "KeyV", false), null);
  // Only explicit sources may start a recording (e.g. no "vad" auto-start).
  assert.deepEqual(v.start(1000, ctx, /** @type {any} */ ("vad")), { type: "rejected", reason: "bad-source", t: 1000 });
  assert.equal(v.view().recording, false);
  // A key-started utterance is not ended by another source's double start.
  v.key(2000, "KeyV", true);
  assert.equal(v.start(2100).type, "rejected");
  assert.equal(v.key(2600, "KeyV", false)?.type, "utterance");
  // A gesture/button-started utterance is not ended by the push-to-talk key's release.
  v.start(3000, ctx, "gesture");
  assert.equal(v.key(3500, "KeyV", false), null);
  assert.equal(v.view().recording, true);
});

test("hostile inputs are rejected and never throw", () => {
  const v = createVoice(/** @type {any} */ ({ minMs: NaN, maxMs: -1, preMs: Infinity, key: 5, maxGestures: 1e12 }));
  assert.deepEqual([v.config.minMs, v.config.maxMs, v.config.key], [300, 15000, "KeyV"]);
  assert.equal(v.config.preMs, 2000);
  assert.equal(v.config.maxGestures, 1024);
  for (const t of [NaN, Infinity, -Infinity, "1", null, undefined]) {
    assert.equal(v.start(/** @type {any} */ (t)).type, "rejected");
  }
  assert.equal(v.start(1000, { fn: () => 1 }).type, "rejected", "uncloneable context");
  v.start(1000, ctx);
  assert.equal(v.stop(500).type, "rejected", "time running backwards");
  assert.equal(v.tick(NaN), null);
  for (const g of [null, 1, "x", {}, { type: "swipe" }, { type: "swipe", t: NaN }, { type: 1, t: 1200 }]) v.gesture(g);
  v.gesture({ type: "chop", t: 1300 });
  v.gesture({ type: "chop", t: 1200 }); // backwards: dropped
  const u = /** @type {any} */ (v.stop(2000)).utterance;
  assert.deepEqual(u.gestures, [{ type: "chop", t: 1300 }]);
  assert.equal(createVoice({ minMs: 9000, maxMs: 1000 }).config.minMs, 1000, "min never exceeds max");
});
