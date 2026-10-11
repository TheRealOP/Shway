// Replay tests for the gesture recognizer. Run: node --test surface/gestures/*.test.mjs
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

// Poses: which fingertips (landmark ids) curl onto the palm, and where the thumb tip goes.
const POSES = {
  fist: { curl: [8, 12, 16, 20], thumb: [-0.025, 0.075] }, // fingers curled onto the thumb
  point: { curl: [12, 16, 20], thumb: [-0.07, 0.06] }, // index out, thumb tucked away from the middle tip
  pointTap: { curl: [12, 16, 20], thumb: [-0.015, 0.07] }, // pointing, thumb on the curled middle tip
  horns: { curl: [12, 16], thumb: [-0.014, 0.072] }, // 🤘: thumb holding the middle and ring tips
};
const curled = ([px]) => [px * 0.5 - 0.02, 0.07];

/** One hand pose: twist (deg about the forearm), image position, pinch or pose, jitter. */
// pose: "horns" = thumb to index tip; "middle" = thumb to middle tip (open hand). pose: a POSES key.
// bend: wrist flick, degrees the fingers swing in the image plane. thumbZ: depth-estimate error on the thumb tip.
function hand({ twist = 0, x = 0.5, y = 0.5, pinch = false, pose = null, left = false, score = 0.95, jitter = 0.0015, bend = 0, thumbZ = 0 } = {}) {
  const b = (bend * Math.PI) / 180;
  const a = (twist * Math.PI) / 180;
  const P = POSES[pose];
  const shape = BASE.map((q, i) => (P?.curl.includes(i) ? curled(q) : i === 4 && P ? P.thumb : q));
  const target = pinch === "middle" ? BASE[12] : BASE[8];
  const world = shape.map(([px, py], i) => {
    let [wx, wy] = i === 4 && pinch ? target : [px, py];
    if (i === 4 && pinch) wx += 0.005;
    const wz = 0;
    // rotate about +y, then mirror x for a left hand
    let rx = wx * Math.cos(a) + wz * Math.sin(a);
    const rz = -wx * Math.sin(a) + wz * Math.cos(a) + (i === 4 ? thumbZ : 0);
    const by = wy * Math.cos(b) - rx * Math.sin(b);
    rx = rx * Math.cos(b) + wy * Math.sin(b);
    if (left) rx = -rx;
    return { x: rx + rand() * jitter, y: by + rand() * jitter, z: rz + rand() * jitter };
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

test("🤘 engages; signed twist shuttles; neutral pauses; release stops", () => {
  const evs = replay([
    ...frames(0, 300, () => ({ hand: hand() })),
    ...frames(330, 300, () => ({ hand: hand({ pose: "horns" }) })),
    ...frames(660, 300, () => ({ hand: hand({ pose: "horns", twist: 8 }) })), // inside dead zone
    ...frames(990, 300, () => ({ hand: hand({ pose: "horns", twist: 30 }) })),
    ...frames(1320, 300, () => ({ hand: hand({ pose: "horns", twist: 0 }) })),
    ...frames(1650, 300, () => ({ hand: hand({ pose: "horns", twist: -30 }) })),
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

// Changed deliberately (Part 2): the 🤘 pose replaced the thumb–index pinch as the engage pose.
test("only 🤘 engages: a pinch, a thumb–middle pinch, a point or a fist don't", () => {
  for (const opts of [{ pinch: true }, { pinch: "middle" }, { pose: "point" }, { pose: "fist" }]) {
    const evs = replay(frames(0, 600, () => ({ hand: hand(opts) })));
    assert.ok(!types(evs).includes("engage"), JSON.stringify(opts));
    assert.ok(!types(evs).includes("shuttle"), JSON.stringify(opts));
  }
  assert.deepEqual(replay(frames(0, 600, () => ({ hand: hand({ pinch: true, twist: 40 }) }))), [], "pinch + twist does nothing");
  assert.equal(replay(frames(0, 100, () => ({ hand: hand({ pose: "horns" }) })))[0]?.type, "engage");
});

test("shuttle rate is bounded at extreme twist", () => {
  const evs = replay([
    { t: 0, hand: hand({ pose: "horns" }) },
    ...frames(33, 1000, (p) => ({ hand: hand({ pose: "horns", twist: 170 * p }) })),
  ]);
  const r = shuttles(evs);
  assert.ok(r.length > 0);
  assert.ok(r.every((v) => Math.abs(v) <= 4));
  assert.equal(r.at(-1), 4);
});

test("left and right hands give the same sign for the mirrored motion", () => {
  const run = (left) => shuttles(replay([
    { t: 0, hand: hand({ pose: "horns", left }) },
    ...frames(33, 600, () => ({ hand: hand({ pose: "horns", left, twist: 40 }) })),
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
    { t: 0, hand: hand({ pose: "horns" }), fine: true },
    ...frames(33, 1000, (p) => ({ hand: hand({ pose: "horns", twist: 40 * p }), fine: true })),
    ...frames(1066, 1000, (p) => ({ hand: hand({ pose: "horns", twist: 40 * (1 - p) }), fine: true })),
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
    { t: 0, hand: hand({ pose: "horns" }) },
    ...frames(33, 500, () => ({ hand: hand({ pose: "horns", twist: 50 }) })),
    ...frames(566, 300, () => ({ hand: hand({ pose: "horns", twist: 50 }), fine: true })),
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
    { t: 0, hand: hand({ pose: "horns" }) },
    ...frames(33, 200, (p) => ({ hand: hand({ pose: "horns", twist: 30, x: 0.7 - 0.4 * p }) })),
    ...frames(266, 200, (p) => ({ hand: hand({ x: 0.3 + 0.4 * p }) })), // released, still moving
  ]);
  assert.ok(!evs.some((e) => e.type === "swipe"));
  assert.ok(types(evs).includes("release"));
});

test("tracking loss pauses and requires re-engagement", () => {
  const evs = replay([
    { t: 0, hand: hand({ pose: "horns" }) },
    ...frames(33, 400, () => ({ hand: hand({ pose: "horns", twist: 40 }) })),
    { t: 466, hand: null },
    ...frames(500, 400, () => ({ hand: hand({ pose: "horns", twist: 40 }) })), // back, still pinched
    ...frames(933, 100, () => ({ hand: hand({ twist: 40 }) })), // let go
    ...frames(1066, 400, () => ({ hand: hand({ pose: "horns", twist: 40 }) })), // re-engage at new neutral
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
    hand({ pose: "horns", twist: 40, score: 0.3 }),
    { ...hand({ pose: "horns" }), world: hand().world.slice(0, 10) },
    { ...hand({ pose: "horns" }), world: hand().world.map((p, i) => (i === 9 ? { x: NaN, y: 0, z: 0 } : p)) },
    { ...hand({ pose: "horns" }), image: undefined },
  ]) {
    const evs = replay([
      { t: 0, hand: hand({ pose: "horns" }) },
      ...frames(33, 300, () => ({ hand: hand({ pose: "horns", twist: 40 }) })),
      { t: 400, hand: bad },
    ]);
    assert.equal(evs.at(-1).type, "tracking-lost");
  }
});

test("handedness flip mid-gesture counts as tracking loss", () => {
  const evs = replay([
    { t: 0, hand: hand({ pose: "horns" }) },
    { t: 33, hand: { ...hand({ pose: "horns" }), handedness: "Left" } },
  ]);
  assert.deepEqual(types(evs), ["engage", "tracking-lost"]);
});

test("cancel stops and latches until released", () => {
  const evs = replay([
    { t: 0, hand: hand({ pose: "horns" }) },
    ...frames(33, 300, () => ({ hand: hand({ pose: "horns", twist: 40 }) })),
    { t: 400, hand: hand({ pose: "horns", twist: 40 }), cancel: true },
    ...frames(433, 300, () => ({ hand: hand({ pose: "horns", twist: -40 }) })),
  ]);
  const i = types(evs).indexOf("cancel");
  assert.equal(evs[i - 1].rate, 0);
  assert.equal(evs.length, i + 1);
});

// Thumb–middle taps: `pattern` is [closed?, ms] segments.
const taps = (pattern, extra = {}) => {
  const out = [];
  let t = 0;
  for (const [closed, ms] of pattern) {
    for (const end = t + ms; t < end; t += 33) out.push({ t, hand: hand({ pinch: closed ? "middle" : false, ...extra }) });
  }
  return out;
};

test("thumb–middle double tap fires one draw-toggle", () => {
  const evs = replay(taps([[0, 300], [1, 100], [0, 130], [1, 100], [0, 300]]));
  assert.deepEqual(evs.map((e) => [e.type, e.drawing]), [["draw-toggle", true]]); // was "double-tap" (play/pause) before Part 2
});

test("single, slow, or held taps are not a double tap", () => {
  assert.deepEqual(replay(taps([[0, 300], [1, 100], [0, 600]])), [], "single");
  assert.deepEqual(replay(taps([[0, 300], [1, 100], [0, 800], [1, 100], [0, 300]])), [], "gap too long");
  assert.deepEqual(replay(taps([[0, 300], [1, 600], [0, 130], [1, 100], [0, 300]])), [], "first was a hold");
});

test("a tap interrupted by tracking loss does not pair up", () => {
  const evs = replay([
    ...taps([[0, 300], [1, 100], [0, 66]]),
    { t: 520, hand: null },
    ...taps([[1, 100], [0, 300]]).map((f) => ({ ...f, t: f.t + 553 })),
  ]);
  assert.deepEqual(evs, []);
});

test("a wrist flick (palm still, fingers swing down) cuts", () => {
  const still = frames(0, 300, () => ({ hand: hand({ twist: 75 }) }));
  const flick = frames(330, 150, (p) => ({ hand: hand({ twist: 75, bend: 70 * p }) }));
  assert.deepEqual(types(replay([...still, ...flick])), ["chop"]);
  // Motion blur drops a frame mid-flick.
  const blurred = flick.map((f, i) => (i === 2 ? { t: f.t, hand: null } : f));
  assert.deepEqual(types(replay([...still, ...blurred])), ["chop"]);
});

test("a sideways thumb–middle double tap with noisy fingertip depth still fires", () => {
  const evs = replay(taps([[0, 300], [1, 100], [0, 130], [1, 100], [0, 300]], { twist: 60, thumbZ: 0.03 }));
  assert.deepEqual(evs.map((e) => [e.type, e.drawing]), [["draw-toggle", true]]); // was "double-tap" (play/pause) before Part 2
});

const chop = (t0, opts = {}) => frames(t0, 200, (p) => ({ hand: hand({ twist: 75, y: 0.3 + 0.3 * p, ...opts }) }));

test("a downward edge-on straight-hand chop fires one cut", () => {
  const evs = replay([...frames(0, 300, () => ({ hand: hand({ twist: 75, y: 0.3 }) })), ...chop(330)]);
  assert.deepEqual(types(evs), ["chop"]);
});

test("chop cooldown: a bounce right after does not cut twice", () => {
  const evs = replay([...chop(0), ...frames(833, 200, (p) => ({ hand: hand({ twist: 75, y: 0.3 + 0.3 * p }) }))]);
  assert.deepEqual(types(evs), ["chop"]);
});

test("palm-facing drops, curled hands, slow moves and upward moves don't cut", () => {
  assert.deepEqual(replay(chop(0, { twist: 0 })), [], "palm facing camera");
  assert.deepEqual(types(replay(chop(0, { pose: "fist" }))), ["pause"], "fist: pauses (Part 2), never cuts");
  assert.deepEqual(replay(frames(0, 2000, (p) => ({ hand: hand({ twist: 75, y: 0.3 + 0.3 * p }) }))), [], "slow");
  assert.deepEqual(replay(frames(0, 200, (p) => ({ hand: hand({ twist: 75, y: 0.6 - 0.3 * p }) }))), [], "upward");
});

test("a sideways swipe in blade pose is a swipe, not a cut", () => {
  const evs = replay(frames(0, 200, (p) => ({ hand: hand({ twist: 75, x: 0.7 - 0.4 * p }) })));
  assert.deepEqual(types(evs), ["swipe"]);
});

test("chop is suppressed while engaged", () => {
  const evs = replay([{ t: 0, hand: hand({ twist: 75 }), key: true }, ...chop(33).map((f) => ({ ...f, key: true }))]);
  assert.ok(!types(evs).includes("chop"));
});

test("hostile frames never throw and are ignored", () => {
  const r = createRecognizer();
  for (const f of [null, undefined, {}, { t: NaN }, { t: Infinity }, { t: "5" }, { t: 1, hand: 7 },
    { t: 2, hand: { world: "x", image: [], score: 1 } }, { t: 3, hand: { ...hand(), score: NaN } }]) {
    assert.deepEqual(r.step(/** @type {any} */ (f)), []);
  }
  r.step({ t: 100, hand: hand() });
  assert.deepEqual(r.step({ t: 50, hand: hand({ pose: "horns" }) }), [], "time going backwards is ignored");
  // Degenerate geometry: every landmark at one point.
  const zero = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  assert.deepEqual(r.step({ t: 200, hand: { world: zero, image: zero, handedness: "Right", score: 1 } }), []);
  assert.deepEqual(replay(/** @type {any} */ ("nope")), []);
});

test("traces survive a JSON round trip (recorder format)", () => {
  const trace = [{ t: 0, hand: hand({ pose: "horns" }) }, ...frames(33, 400, () => ({ hand: hand({ pose: "horns", twist: 30 }) }))];
  assert.deepEqual(replay(JSON.parse(JSON.stringify(trace))), replay(trace));
});

// ---- Part 2 grammar: point, draw, fist pause / slide.
/** Frames for consecutive [opts | (p) => opts | null, ms] segments; null = no hand. */
const seq = (segments) => {
  const out = [];
  let t = 0;
  for (const [opts, ms] of segments) {
    const t0 = t;
    for (const end = t + ms; t < end; t += 33) {
      const o = typeof opts === "function" ? opts((t - t0) / ms) : opts;
      out.push({ t, hand: o && hand(o) });
    }
  }
  return out;
};
const notPointer = (evs) => evs.filter((e) => e.type !== "pointer");
const POINT = { pose: "point" }, TAP = { pose: "pointTap" }, FIST = { pose: "fist" };
const drawOn = [[POINT, 300], [TAP, 100], [POINT, 130], [TAP, 100]];

test("point: the index tip drives a smoothed, mirrored 0–1 pointer, emitted on change only", () => {
  const r = createRecognizer();
  const evs = seq([[(p) => ({ pose: "point", x: 0.6 - 0.2 * p }), 600], [{ pose: "point", x: 0.4 }, 600]]).flatMap((f) => r.step(f));
  const ptr = evs.filter((e) => e.type === "pointer");
  assert.deepEqual(notPointer(evs), [], "pointing alone does nothing else (no swipe, no engage)");
  assert.ok(ptr.length > 5 && ptr.length < 36, `${ptr.length} pointer events`);
  assert.ok(ptr.every((e) => e.x >= 0 && e.x <= 1 && e.y >= 0 && e.y <= 1));
  assert.ok(ptr.at(-1).x > ptr[0].x + 0.25, "hand moving to image-left (the user's right) moves the dot right");
  for (let i = 1; i < ptr.length; i++) assert.ok(Math.max(Math.abs(ptr[i].x - ptr[i - 1].x), Math.abs(ptr[i].y - ptr[i - 1].y)) >= 0.003 - 1e-4);
  assert.deepEqual(Object.keys(r.view().pointer), ["x", "y"]);
  r.step({ t: 2000, hand: hand() });
  assert.equal(r.view().pointer, null, "an open hand hides the pointer");
  assert.equal(r.view().pose, "open");
});

test("draw-toggle and pen: point = pen down, other poses = pen up; the ending tap doesn't leave a stroke", () => {
  const evs = replay(seq([
    ...drawOn,
    [(p) => ({ pose: "point", x: 0.5 + 0.1 * p }), 300], // stroke 1
    [{}, 200], // open hand: pen up
    [(p) => ({ pose: "point", y: 0.5 + 0.1 * p }), 300], // stroke 2
    [TAP, 100], [POINT, 130], [TAP, 100], [POINT, 300], // double tap: drawing off
  ]));
  assert.deepEqual(notPointer(evs).map((e) => e.type + (e.drawing === undefined ? "" : ` ${e.drawing}`)),
    ["draw-toggle true", "pen-down", "pen-up", "pen-down", "pen-up", "draw-toggle false"]);
  const at = (type, n = 0) => evs.filter((e) => e.type === type)[n].t;
  const inStroke = (a, b) => evs.filter((e) => e.type === "pointer" && e.t >= a && e.t <= b).length;
  assert.ok(inStroke(at("pen-down"), at("pen-up")) >= 5, "stroke 1 has points");
  assert.ok(inStroke(at("pen-down", 1), at("pen-up", 1)) >= 5, "stroke 2 has points");
  // The first tap of "drawing off" lifts the pen on its first frame, and no stroke starts before the toggle.
  assert.equal(at("pen-up", 1), seq([...drawOn, [POINT, 300], [{}, 200], [POINT, 300]]).at(-1).t + 33);
});

test("a single tap while drawing lifts the pen briefly; a resting thumb on the middle finger doesn't block drawing", () => {
  const evs = notPointer(replay(seq([...drawOn, [POINT, 300], [TAP, 100], [POINT, 600], [TAP, 1000]])));
  assert.deepEqual(types(evs), ["draw-toggle", "pen-down", "pen-up", "pen-down", "pen-up", "pen-down"]);
  const [, , up, down, up2, down2] = evs;
  assert.ok(down.t - up.t >= 400 && down.t - up.t < 600, "pen back down once no second tap came");
  assert.ok(down2.t - up2.t > 350 && down2.t - up2.t < 400, "a held thumb (not a tap) lets the pen down again");
});

test("fist held → pause; opening the hand → release; slid fist → absolute slide offsets", () => {
  const evs = replay(seq([
    [{}, 300], [FIST, 300],
    [(p) => ({ pose: "fist", x: 0.5 - 0.15 * p }), 400], // user's right by a quarter of the box
    [{ pose: "fist", x: 0.35 }, 300],
    [(p) => ({ pose: "fist", x: 0.35 + 0.15 * p }), 400], [FIST, 300], // back to where it closed
    [{}, 300],
  ]));
  assert.deepEqual(types(notPointer(evs)).filter((t) => t !== "slide"), ["pause", "release"]);
  const pause = evs.find((e) => e.type === "pause");
  assert.ok(pause.t >= 450 && pause.t <= 500, `pause after ~150 ms of fist, at ${pause.t}`);
  const s = evs.filter((e) => e.type === "slide").map((e) => e.seconds);
  assert.ok(s.length >= 4);
  const peak = Math.max(...s);
  assert.ok(Math.abs(peak - 4.4) <= 0.1, `peak ${peak}: (0.25 - 0.03 dead zone) × 20 s`);
  assert.ok(s.every((v) => Math.abs(Math.round(v / 0.05) * 0.05 - v) < 1e-9), "quantized to slideStep");
  assert.equal(s.at(-1), 0, "back to the start is back to 0, no drift");
  for (let i = 1; i < s.length; i++) assert.notEqual(s[i], s[i - 1], "emitted on change only");
  assert.ok(evs.find((e) => e.type === "slide").t > pause.t);
  const left = replay(seq([[FIST, 300], [(p) => ({ pose: "fist", x: 0.5 + 0.15 * p }), 400], [{ pose: "fist", x: 0.65 }, 300]])).filter((e) => e.type === "slide");
  assert.ok(left.at(-1).seconds < -4, "the other way scrubs back");
});

test("a brief fist between poses doesn't pause", () => {
  const evs = replay(seq([[{}, 300], [FIST, 100], [POINT, 300], [FIST, 100], [{}, 300]]));
  assert.deepEqual(notPointer(evs), []);
});

test("no swipe while pointing or in a fist", () => {
  const fast = (opts) => (p) => ({ ...opts, x: 0.7 - 0.4 * p });
  assert.deepEqual(notPointer(replay(seq([[POINT, 300], [fast(POINT), 200], [POINT, 300]]))), [], "pointing");
  const fist = types(replay(seq([[FIST, 300], [fast(FIST), 200], [FIST, 300]])));
  assert.ok(!fist.includes("swipe") && fist.includes("slide"), "fist slides, never swipes");
  assert.deepEqual(replay(seq([[fast(FIST), 120]])), [], "a fast fist that never settles does nothing");
  assert.deepEqual(types(replay(seq([[{}, 300], [fast({}), 200]]))), ["swipe"], "an open hand still swipes");
});

test("no slide (and no scrub) while drawing: a fist only pauses and lifts the pen", () => {
  const evs = replay(seq([
    ...drawOn, [POINT, 200],
    [FIST, 300], [(p) => ({ pose: "fist", x: 0.5 - 0.2 * p }), 300], [{ pose: "fist", x: 0.3 }, 200],
    [{ pose: "horns", twist: 40 }, 300], // 🤘 doesn't engage either
  ]));
  assert.deepEqual(types(notPointer(evs)), ["draw-toggle", "pen-down", "pen-up", "pause", "release"]);
});

test("fist: tracking loss latches until the fist opens; Esc cancels; Esc while drawing drops the sketch", () => {
  const lost = replay([...seq([[FIST, 300]]), { t: 330, hand: null }, ...seq([[FIST, 400]]).map((f) => ({ ...f, t: f.t + 363 })),
    ...seq([[{}, 100], [FIST, 300]]).map((f) => ({ ...f, t: f.t + 800 }))]);
  assert.deepEqual(types(notPointer(lost)), ["pause", "tracking-lost", "pause"]);
  assert.ok(lost.at(-1).t >= 1050, "re-paused only after letting go");
  const esc = replay([...seq([[FIST, 300]]), { t: 330, hand: hand(FIST), cancel: true }, ...seq([[FIST, 300]]).map((f) => ({ ...f, t: f.t + 363 }))]);
  assert.deepEqual(types(esc), ["pause", "cancel"]);
  const draw = seq([...drawOn, [POINT, 200]]);
  const ink = notPointer(replay([...draw, { t: draw.at(-1).t + 33, hand: hand(POINT), cancel: true }, { t: draw.at(-1).t + 66, hand: hand(POINT) }]));
  assert.deepEqual(types(ink), ["draw-toggle", "pen-down", "pen-up", "cancel"]);
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
