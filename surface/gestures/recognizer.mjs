// @ts-check
// Shway gesture recognizer (DEV-91): hand landmarks + keys in, navigation events out.
// Pure and deterministic: no camera, DOM, clock or editor access, so recorded traces replay exactly.
// Editor command execution lives on the other side of the event boundary (see README.md).

/**
 * @typedef {{x: number, y: number, z: number}} P3
 * @typedef {{
 *   world: P3[],        // 21 MediaPipe-style landmarks in metric hand coordinates (worldLandmarks)
 *   image: P3[],        // the same 21 landmarks normalized to the camera image (landmarks)
 *   handedness: string, // "Left" | "Right"
 *   score: number,      // tracking confidence 0..1
 * }} Hand
 * @typedef {{
 *   t: number,           // capture time, ms, non-decreasing
 *   hand?: Hand | null,  // null/absent = no hand found
 *   key?: boolean,       // fallback engagement key held
 *   fine?: boolean,      // fine (frame-step) mode modifier held
 *   cancel?: boolean,    // cancel pressed this frame
 * }} Frame
 * @typedef {{type: "engage" | "release" | "cancel" | "tracking-lost" | "double-tap" | "chop", t: number}
 *   | {type: "shuttle", t: number, rate: number}
 *   | {type: "step", t: number, frames: number}
 *   | {type: "swipe", t: number, direction: "left" | "right"}} GestureEvent
 * @typedef {"Idle" | "Armed" | "Adjusting" | "TrackingLost" | "Cancelled"} State
 */

export const DEFAULTS = {
  minScore: 0.6,
  pinchOn: 0.35, // thumb–index tip distance / palm length: engage below, release above pinchOff
  pinchOff: 0.5,
  pinchIndexOnly: 1.5, // engage only if the thumb is this many times closer to the index tip than the middle tip (rejects thumb–middle pinches and fists)
  smoothing: 0.5, // EMA weight of each new twist sample, (0, 1]
  deadZoneDeg: 12,
  maxDeg: 60, // twist beyond the dead zone at which the fastest rate is reached
  rates: [0.5, 1, 2, 4], // shuttle speed bands (× realtime); quantized so playback isn't restarted every frame
  fineDetentDeg: 8, // fine mode: one frame per detent of twist
  invert: false, // flip twist sign; calibrate against a real recording
  swipeMinDist: 0.18, // palm travel, fraction of image width, within swipeWindowMs
  swipeWindowMs: 250,
  swipeMaxOffAxis: 0.5, // max |dy| / |dx|
  swipeCooldownMs: 700,
  quietAfterReleaseMs: 400, // no swipes right after an engagement ends
  mirrored: false, // true when landmarks come from a mirrored (selfie) image
  tapOn: 0.3, // thumb–middle tip distance / palm length: closed below, open above tapOff
  tapOff: 0.45,
  tapMaxMs: 350, // a tap closes and opens within this
  doubleTapGapMs: 400, // second tap must start within this of the first ending
  chopMinDist: 0.2, // downward palm travel, fraction of image height, within swipeWindowMs
  chopMaxOffAxis: 0.5, // max |dx| / dy
  chopBladeMax: 0.6, // knuckle line's share facing the camera: below = hand edge-on (a blade)
  fingerStraight: 1.5, // fingertip reaches this × its knuckle's distance from the wrist
  chopCooldownMs: 1000,
};

const WRIST = 0, THUMB_TIP = 4, INDEX_MCP = 5, INDEX_TIP = 8, MIDDLE_MCP = 9, MIDDLE_TIP = 12, PINKY_MCP = 17;
const FINGERS = [[5, 8], [9, 12], [13, 16], [17, 20]]; // [knuckle, tip]
const DEG = 180 / Math.PI;

/** @param {P3} a @param {P3} b */
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
/** @param {P3} a @param {P3} b */
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
/** @param {P3} a @param {P3} b */
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
/** @param {P3} a @param {number} k */
const scale = (a, k) => ({ x: a.x * k, y: a.y * k, z: a.z * k });
/** @param {P3} a */
const len = (a) => Math.sqrt(dot(a, a));

/** @param {unknown} pts */
function validPoints(pts) {
  return Array.isArray(pts) && pts.length >= 21 &&
    pts.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z ?? 0));
}

/** Hand usable for control, or null (missing, occluded, low confidence, malformed). */
function usableHand(/** @type {any} */ hand, /** @type {number} */ minScore) {
  if (!hand || !Number.isFinite(hand.score) || hand.score < minScore) return null;
  if (!validPoints(hand.world) || !validPoints(hand.image)) return null;
  if (len(sub(hand.world[MIDDLE_MCP], hand.world[WRIST])) < 1e-6) return null;
  return /** @type {Hand} */ (hand);
}

/** Unit vector across the knuckles, perpendicular to `axis` (wrist → middle knuckle). */
function across(/** @type {P3[]} */ w, /** @type {P3} */ axis) {
  const v = sub(w[PINKY_MCP], w[INDEX_MCP]);
  const p = sub(v, scale(axis, dot(v, axis)));
  const l = len(p);
  return l < 1e-9 ? null : scale(p, 1 / l);
}

/** Flat straight hand turned edge-on to the camera, like a blade. */
function isBlade(/** @type {P3[]} */ w, /** @type {typeof DEFAULTS} */ c) {
  const straight = FINGERS.every(([m, t]) => len(sub(w[t], w[WRIST])) > c.fingerStraight * len(sub(w[m], w[WRIST])));
  const k = sub(w[PINKY_MCP], w[INDEX_MCP]);
  const l = len(k);
  return straight && l > 1e-9 && Math.hypot(k.x, k.y) / l < c.chopBladeMax;
}

/** Forearm-axis unit vector (wrist → middle knuckle). */
function axisOf(/** @type {P3[]} */ w) {
  const a = sub(w[MIDDLE_MCP], w[WRIST]);
  return scale(a, 1 / len(a));
}

/** @param {Partial<typeof DEFAULTS>} [config] */
export function createRecognizer(config = {}) {
  const c = { ...DEFAULTS, ...config };
  /** @type {State} */ let state = "Idle";
  let lastT = -Infinity;
  let pinching = false;
  let handedness = "";
  /** @type {P3 | null} */ let neutral = null; // knuckle direction captured at engagement
  let angle = 0; // smoothed twist from neutral, degrees, signed
  let rate = 0;
  let fine = false;
  let detent = 0;
  let cooldownUntil = -Infinity;
  /** @type {{t: number, x: number, y: number, blade: boolean}[]} */ let track = [];
  let tapping = false; // thumb–middle closed
  let tapStart = -Infinity;
  let lastTap = -Infinity; // end of a single tap awaiting its pair
  let blade = false; // hand currently chop-ready, for feedback
  let confidence = 0;
  let pinchRatio = Infinity; // last thumb–index / palm ratio, for feedback

  /** @param {GestureEvent[]} out @param {number} t */
  const stop = (out, t) => {
    if (rate !== 0) out.push({ type: "shuttle", t, rate: 0 });
    rate = 0;
  };

  /** Twist since engagement in degrees (+ = forward), or null if the geometry is degenerate. */
  const rawTwist = (/** @type {Hand} */ h) => {
    const axis = axisOf(h.world);
    const cur = across(h.world, axis);
    if (!cur || !neutral) return null;
    // Re-project the neutral onto the current plane so forearm drift doesn't read as twist.
    const ref = sub(neutral, scale(axis, dot(neutral, axis)));
    if (len(ref) < 1e-9) return null;
    let a = Math.atan2(dot(axis, cross(ref, cur)), dot(ref, cur)) * DEG;
    if (h.handedness === "Left") a = -a; // mirror anatomy: same motion, same sign on either hand
    return c.invert ? -a : a;
  };

  /** @param {Frame} f @returns {GestureEvent[]} */
  function step(f) {
    /** @type {GestureEvent[]} */ const out = [];
    if (!f || !Number.isFinite(f.t) || f.t < lastT) return out;
    const t = f.t;
    lastT = t;
    const h = usableHand(f.hand, c.minScore);
    let tapEnded = false;
    blade = false;
    confidence = Number.isFinite(f.hand?.score) ? Number(f.hand?.score) : 0;
    if (h) {
      const palm = len(sub(h.world[MIDDLE_MCP], h.world[WRIST]));
      const pinch = len(sub(h.world[THUMB_TIP], h.world[INDEX_TIP])) / palm;
      pinchRatio = pinch;
      const middle = len(sub(h.world[THUMB_TIP], h.world[MIDDLE_TIP])) / palm;
      pinching = pinching ? pinch < c.pinchOff : pinch < c.pinchOn && middle > pinch * c.pinchIndexOnly;
      const wasTapping = tapping;
      tapping = tapping ? middle < c.tapOff : middle < c.tapOn && pinch > middle * c.pinchIndexOnly;
      if (tapping && !wasTapping) tapStart = t;
      if (!tapping && wasTapping) tapEnded = true;
    } else {
      pinching = false;
      tapping = false;
      pinchRatio = Infinity;
    }
    const engage = Boolean(f.key) || pinching;

    if (state === "Armed" || state === "Adjusting") {
      if (!h || h.handedness !== handedness) {
        stop(out, t);
        state = "TrackingLost";
        out.push({ type: "tracking-lost", t });
      } else if (f.cancel) {
        stop(out, t);
        state = "Cancelled";
        out.push({ type: "cancel", t });
      } else if (!engage) {
        stop(out, t);
        state = "Idle";
        cooldownUntil = Math.max(cooldownUntil, t + c.quietAfterReleaseMs);
        out.push({ type: "release", t });
      } else {
        const raw = rawTwist(h);
        if (raw !== null) angle += c.smoothing * (raw - angle);
        const mag = Math.abs(angle) - c.deadZoneDeg;
        const sign = Math.sign(angle);
        const d = mag > 0 ? sign * Math.ceil(mag / c.fineDetentDeg) : 0;
        if (Boolean(f.fine) !== fine) {
          fine = Boolean(f.fine);
          stop(out, t);
          detent = d; // switching modes never jumps the playhead
        }
        if (fine) {
          if (d !== detent) out.push({ type: "step", t, frames: d - detent });
          detent = d;
        } else {
          const n = c.rates.length;
          const band = Math.min(n - 1, Math.floor((mag / Math.max(1e-9, c.maxDeg - c.deadZoneDeg)) * n));
          const r = mag > 0 && n > 0 ? sign * (c.rates[band] ?? 0) : 0;
          if (r !== rate) out.push({ type: "shuttle", t, rate: r });
          rate = r;
        }
        state = mag > 0 ? "Adjusting" : "Armed";
      }
      track = [];
      lastTap = -Infinity;
      return out;
    }

    if (state === "TrackingLost" || state === "Cancelled") {
      if (!engage) state = "Idle"; // re-engagement requires letting go first
      track = [];
      return out;
    }

    // Idle
    if (h && engage) {
      const axis = axisOf(h.world);
      neutral = across(h.world, axis);
      if (neutral) {
        handedness = h.handedness;
        angle = 0;
        rate = 0;
        fine = Boolean(f.fine);
        detent = 0;
        state = "Armed";
        track = [];
        out.push({ type: "engage", t });
        return out;
      }
    }
    if (!h || engage) {
      track = [];
      lastTap = -Infinity;
      return out;
    }
    if (tapEnded) {
      if (t - tapStart > c.tapMaxMs) lastTap = -Infinity; // a hold, not a tap
      else if (tapStart - lastTap <= c.doubleTapGapMs) {
        out.push({ type: "double-tap", t });
        lastTap = -Infinity;
      } else lastTap = t;
    }
    const w = h.image;
    const x = (w[WRIST].x + w[INDEX_MCP].x + w[PINKY_MCP].x) / 3;
    const y = (w[WRIST].y + w[INDEX_MCP].y + w[PINKY_MCP].y) / 3;
    blade = isBlade(h.world, c);
    track.push({ t, x, y, blade });
    track = track.filter((s) => s.t >= t - c.swipeWindowMs);
    const first = track[0];
    if (t >= cooldownUntil && first && track.every((s) => s.blade)) {
      const dx = x - first.x, dy = y - first.y; // image y grows downward
      if (dy >= c.chopMinDist && Math.abs(dx) <= c.chopMaxOffAxis * dy) {
        out.push({ type: "chop", t });
        cooldownUntil = t + c.chopCooldownMs; // also blocks swipes from the follow-through
        track = [];
        return out;
      }
    }
    if (t >= cooldownUntil && first) {
      const dx = x - first.x, dy = y - first.y;
      if (Math.abs(dx) >= c.swipeMinDist && Math.abs(dy) <= c.swipeMaxOffAxis * Math.abs(dx)) {
        // Camera faces the user: in an unmirrored image the user's right is image left.
        const right = c.mirrored ? dx > 0 : dx < 0;
        out.push({ type: "swipe", t, direction: right ? "right" : "left" });
        cooldownUntil = t + c.swipeCooldownMs;
        track = [];
      }
    }
    return out;
  }

  /** UI snapshot: mode, effect and confidence must stay visible. */
  const view = () => ({ state, rate, fine, angleDeg: angle, handedness, confidence, pinching, pinchRatio, tapping, blade });

  return { step, view };
}

/** Run a recorded trace through a fresh recognizer. @param {Frame[]} frames */
export function replay(frames, config = {}) {
  const r = createRecognizer(config);
  return Array.isArray(frames) ? frames.flatMap((f) => r.step(f)) : [];
}
