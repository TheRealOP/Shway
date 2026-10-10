// Replay tests for the gesture recognizer. Run: node --test surface/gestures/
// Traces are synthetic (a posed hand model + seeded jitter) until real recordings exist;
// any *.json in ./traces is also replayed for crash-safety and resting-hand checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRecognizer, replay } from "./recognizer.mjs";

// Canonical right hand, metres: wrist at origin, fingers up (+y), palm toward the camera.
const BASE = [
  [0, 0], [-0.03, 0.02], [-0.045, 0.04], [-0.055, 0.06], [-0.06, 0.08], // wrist, thumb 1–4
  [-0.025, 0.09], [-0.027, 0.13], [-0.028, 0.155], [-0.029, 0.175], // index 5–8
  [0, 0.095], [0, 0.14], [0, 0.165], [0, 0.185], // middle 9–12
  [0.02, 0.09], [0.022, 0.13], [0.023, 0.152], [0.024, 0.17], // ring 13–16
  [0.038, 0.08], [0.04, 0.11], [0.041, 0.128], [0.042, 0.145], // pinky 17–20
];

let seed = 1;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);

/** One hand pose: twist (deg about the forearm), image position, pinch, jitter. */
function hand({ twist = 0, x = 0.5, y = 0.5, pinch = false, left = false, score = 0.95, jitter = 0.0015 } = {}) {
  const a = (twist * Math.PI) / 180;
  const world = BASE.map(([px, py], i) => {
    let [wx, wy] = i === 4 && pinch ? BASE[8] : [px, py];
    if (i === 4 && pinch) wx += 0.005;
    const wz = 0;
    // rotate about +y, then mirror x for a left hand
    let rx = wx * Math.cos(a) + wz * Math.sin(a);
    const rz = -wx * Math.sin(a) + wz * Math.cos(a);
    if (left) rx = -rx;
    return { x: rx + rand() * jitter, y: wy + rand() * jitter, z: rz + rand() * jitter };
  });
  const image = world.map((p) => ({ x: x + p.x * 1.5, y: y - p.y * 1.5, z: p.z }));
  return { world, image, handedness: left ? "Left" : "Right", score };
}

/** Frames at 30 fps from t0 for `ms`, pose from fn(progress 0..1). */
function frames(t0, ms, fn) {
  const out = [];
  for (let t = t0; t <= t0 + ms; t += 33) out.push({ t, ...fn((t - t0) / ms) });
  return out;
}

const types = (evs) => evs.map((e) => e.type);
const shuttles = (evs) => evs.filter((e) => e.type === "shuttle").map((e) => e.rate);

test("resting hand with jitter and slow drift emits nothing", () => {
  const evs = replay(frames(0, 5000, (p) => ({ hand: hand({ x: 0.4 + 0.2 * p, twist: 5 * Math.sin(p * 9), jitter: 0.004 }) })));
  assert.deepEqual(evs, []);
});

test("pinch engages; signed twist shuttles; neutral pauses; release stops", () => {
  const evs = replay([
    ...frames(0, 300, () => ({ hand: hand() })),
    ...frames(330, 300, () => ({ hand: hand({ pinch: true }) })),
    ...frames(660, 300, () => ({ hand: hand({ pinch: true, twist: 8 }) })), // inside dead zone
    ...frames(990, 300, () => ({ hand: hand({ pinch: true, twist: 30 }) })),
    ...frames(1320, 300, () => ({ hand: hand({ pinch: true, twist: 0 }) })),
    ...frames(1650, 300, () => ({ hand: hand({ pinch: true, twist: -30 }) })),
    ...frames(1980, 300, () => ({ hand: hand({ pinch: false, twist: -30 }) })),
  ]);
  assert.equal(evs[0].type, "engage");
  const r = shuttles(evs);
  assert.ok(r.some((v) => v > 0), "forward twist shuttles forward");
  assert.ok(r.some((v) => v < 0), "backward twist shuttles backward");
  assert.ok(r.includes(0), "neutral pauses");
  assert.equal(evs.at(-1).type, "release");
  assert.equal(evs.at(-2).type, "shuttle"); // stop precedes release
  assert.equal(evs.at(-2).rate, 0);
  // Nothing moved during the dead-zone segment.
  assert.ok(!evs.some((e) => e.type === "shuttle" && e.t >= 660 && e.t < 990));
});

test("shuttle rate is bounded at extreme twist", () => {
  const evs = replay([
    { t: 0, hand: hand({ pinch: true }) },
    ...frames(33, 1000, (p) => ({ hand: hand({ pinch: true, twist: 170 * p }) })),
  ]);
  const r = shuttles(evs);
  assert.ok(r.length > 0);
  assert.ok(r.every((v) => Math.abs(v) <= 4));
  assert.equal(r.at(-1), 4);
});

test("left and right hands give the same sign for the mirrored motion", () => {
  const run = (left) => shuttles(replay([
    { t: 0, hand: hand({ pinch: true, left }) },
    ...frames(33, 600, () => ({ hand: hand({ pinch: true, left, twist: 40 }) })),
  ]));
  const r = run(false), l = run(true);
  assert.ok(r.length && l.length);
  assert.equal(Math.sign(r.at(-1)), Math.sign(l.at(-1)));
});

test("fallback key engages without a pinch", () => {
  const evs = replay([
    { t: 0, hand: hand(), key: true },
    ...frames(33, 600, () => ({ hand: hand({ twist: 30 }), key: true })),
    { t: 700, hand: hand({ twist: 30 }), key: false },
  ]);
  assert.deepEqual(types(evs).filter((t) => t !== "shuttle"), ["engage", "release"]);
  assert.ok(shuttles(evs).some((v) => v > 0));
});

test("fine mode steps frames by detent, returns to zero, never shuttles", () => {
  const evs = replay([
    { t: 0, hand: hand({ pinch: true }), fine: true },
    ...frames(33, 1000, (p) => ({ hand: hand({ pinch: true, twist: 40 * p }), fine: true })),
    ...frames(1066, 1000, (p) => ({ hand: hand({ pinch: true, twist: 40 * (1 - p) }), fine: true })),
  ]);
  const steps = evs.filter((e) => e.type === "step");
  assert.ok(steps.length >= 3);
  const peak = Math.max(...steps.reduce((acc, s) => [...acc, (acc.at(-1) ?? 0) + s.frames], []));
  assert.ok(peak >= 3 && peak <= 4, `peak ${peak}`); // (40 - 12) / 8 → 4 detents, smoothing may lag one
  assert.equal(steps.reduce((s, e) => s + e.frames, 0), 0);
  assert.deepEqual(shuttles(evs), []);
});

test("switching into fine mode while twisted does not jump", () => {
  const evs = replay([
    { t: 0, hand: hand({ pinch: true }) },
    ...frames(33, 500, () => ({ hand: hand({ pinch: true, twist: 50 }) })),
    ...frames(566, 300, () => ({ hand: hand({ pinch: true, twist: 50 }), fine: true })),
  ]);
  assert.ok(!evs.some((e) => e.type === "step"));
  assert.equal(shuttles(evs).at(-1), 0);
});

test("a deliberate swipe fires once, then cooldown, then again", () => {
  const fast = (t0, from, to) => frames(t0, 200, (p) => ({ hand: hand({ x: from + (to - from) * p }) }));
  const evs = replay([
    ...frames(0, 300, () => ({ hand: hand({ x: 0.7 }) })),
    ...fast(330, 0.7, 0.3), // image-left = user's right (unmirrored)
    ...fast(560, 0.3, 0.7), // inside cooldown
    ...frames(790, 600, () => ({ hand: hand({ x: 0.7 }) })),
    ...fast(1420, 0.7, 0.3),
  ]);
  assert.deepEqual(evs.map((e) => e.type === "swipe" && e.direction), ["right", "right"]);
});

test("mirrored input flips swipe direction", () => {
  const evs = replay(frames(0, 200, (p) => ({ hand: hand({ x: 0.7 - 0.4 * p }) })), { mirrored: true });
  assert.deepEqual(evs, [{ type: "swipe", t: evs[0]?.t, direction: "left" }]);
});

test("the same travel done slowly or diagonally is not a swipe", () => {
  assert.deepEqual(replay(frames(0, 2000, (p) => ({ hand: hand({ x: 0.7 - 0.4 * p }) }))), []);
  assert.deepEqual(replay(frames(0, 200, (p) => ({ hand: hand({ x: 0.7 - 0.25 * p, y: 0.3 + 0.3 * p }) }))), []);
});

test("swipes are suppressed while engaged and right after release", () => {
  const evs = replay([
    { t: 0, hand: hand({ pinch: true }) },
    ...frames(33, 200, (p) => ({ hand: hand({ pinch: true, twist: 30, x: 0.7 - 0.4 * p }) })),
    ...frames(266, 200, (p) => ({ hand: hand({ x: 0.3 + 0.4 * p }) })), // released, still moving
  ]);
  assert.ok(!evs.some((e) => e.type === "swipe"));
  assert.ok(types(evs).includes("release"));
});

test("tracking loss pauses and requires re-engagement", () => {
  const evs = replay([
    { t: 0, hand: hand({ pinch: true }) },
    ...frames(33, 400, () => ({ hand: hand({ pinch: true, twist: 40 }) })),
    { t: 466, hand: null },
    ...frames(500, 400, () => ({ hand: hand({ pinch: true, twist: 40 }) })), // back, still pinched
    ...frames(933, 100, () => ({ hand: hand({ twist: 40 }) })), // let go
    ...frames(1066, 400, () => ({ hand: hand({ pinch: true, twist: 40 }) })), // re-engage at new neutral
  ]);
  const lost = evs.findIndex((e) => e.type === "tracking-lost");
  assert.ok(lost > 0);
  assert.deepEqual(evs[lost - 1], { type: "shuttle", t: 466, rate: 0 });
  const between = evs.filter((e) => e.t > 466 && e.t < 1066);
  assert.deepEqual(between, [], "no control until re-engaged");
  const after = evs.filter((e) => e.t >= 1066);
  assert.deepEqual(types(after), ["engage"], "new neutral: same twist reads as zero");
});

test("low confidence, occlusion and malformed landmarks count as tracking loss", () => {
  for (const bad of [
    hand({ pinch: true, twist: 40, score: 0.3 }),
    { ...hand({ pinch: true }), world: hand().world.slice(0, 10) },
    { ...hand({ pinch: true }), world: hand().world.map((p, i) => (i === 9 ? { x: NaN, y: 0, z: 0 } : p)) },
    { ...hand({ pinch: true }), image: undefined },
  ]) {
    const evs = replay([
      { t: 0, hand: hand({ pinch: true }) },
      ...frames(33, 300, () => ({ hand: hand({ pinch: true, twist: 40 }) })),
      { t: 400, hand: bad },
    ]);
    assert.equal(evs.at(-1).type, "tracking-lost");
  }
});

test("handedness flip mid-gesture counts as tracking loss", () => {
  const evs = replay([
    { t: 0, hand: hand({ pinch: true }) },
    { t: 33, hand: { ...hand({ pinch: true }), handedness: "Left" } },
  ]);
  assert.deepEqual(types(evs), ["engage", "tracking-lost"]);
});

test("cancel stops and latches until released", () => {
  const evs = replay([
    { t: 0, hand: hand({ pinch: true }) },
    ...frames(33, 300, () => ({ hand: hand({ pinch: true, twist: 40 }) })),
    { t: 400, hand: hand({ pinch: true, twist: 40 }), cancel: true },
    ...frames(433, 300, () => ({ hand: hand({ pinch: true, twist: -40 }) })),
  ]);
  const i = types(evs).indexOf("cancel");
  assert.equal(evs[i - 1].rate, 0);
  assert.equal(evs.length, i + 1);
});

test("hostile frames never throw and are ignored", () => {
  const r = createRecognizer();
  for (const f of [null, undefined, {}, { t: NaN }, { t: Infinity }, { t: "5" }, { t: 1, hand: 7 },
    { t: 2, hand: { world: "x", image: [], score: 1 } }, { t: 3, hand: { ...hand(), score: NaN } }]) {
    assert.deepEqual(r.step(/** @type {any} */ (f)), []);
  }
  r.step({ t: 100, hand: hand() });
  assert.deepEqual(r.step({ t: 50, hand: hand({ pinch: true }) }), [], "time going backwards is ignored");
  // Degenerate geometry: every landmark at one point.
  const zero = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  assert.deepEqual(r.step({ t: 200, hand: { world: zero, image: zero, handedness: "Right", score: 1 } }), []);
  assert.deepEqual(replay(/** @type {any} */ ("nope")), []);
});

test("traces survive a JSON round trip (recorder format)", () => {
  const trace = [{ t: 0, hand: hand({ pinch: true }) }, ...frames(33, 400, () => ({ hand: hand({ pinch: true, twist: 30 }) }))];
  assert.deepEqual(replay(JSON.parse(JSON.stringify(trace))), replay(trace));
});

const dir = new URL("./traces/", import.meta.url);
let recorded = [];
try { recorded = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { /* no recordings yet */ }
for (const name of recorded) {
  test(`recorded trace ${name} replays without throwing`, () => {
    const trace = JSON.parse(readFileSync(new URL(name, dir), "utf8"));
    const evs = replay(trace.frames ?? trace);
    if (name.startsWith("rest")) assert.deepEqual(evs, [], "resting traces must not trigger anything");
  });
}
