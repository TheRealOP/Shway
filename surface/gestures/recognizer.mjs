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
 * @typedef {{type: "engage" | "release" | "cancel" | "tracking-lost" | "chop" | "undo" | "pause" | "pen-down" | "pen-up", t: number}
 *   | {type: "shuttle", t: number, rate: number}
 *   | {type: "step", t: number, frames: number}
 *   | {type: "swipe", t: number, direction: "left" | "right"}
 *   | {type: "pointer", t: number, x: number, y: number}
 *   | {type: "slide", t: number, seconds: number}} GestureEvent
 * @typedef {"Idle" | "Armed" | "Adjusting" | "Fist" | "TrackingLost" | "Cancelled"} State
 * @typedef {"open" | "point" | "fist" | "other"} Pose
 */

export const DEFAULTS = {
  minScore: 0.6,
  fingerOut: 1.0, // a finger is extended when its tip is this many times farther from the wrist than its knuckle, else curled
  fistHoldMs: 150, // all four fingers curled this long = pause (a fist passed through between poses doesn't count)
  pointerBox: 0.6, // central share of the camera image mapped onto 0–1 (pointer and slide)
  pointerSmoothing: 0.5, // EMA weight of each new pointer / palm sample, (0, 1]
  pointerMinMove: 0.003, // pointer is emitted when it moves at least this far (0–1 units)
  slideGain: 20, // seconds of playhead per full active-box width of fist travel
  slideDeadZone: 0.03, // fist travel (share of the box) that doesn't move the playhead
  slideStep: 0.05, // slide offsets are quantized to this many seconds, so jitter doesn't seek every frame
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
  swipeHoldMs: 200, // a swipe waits this long: if the hand reverses (a wave) it is dropped
  quietAfterReleaseMs: 400, // no swipes right after an engagement ends
  mirrored: false, // true when landmarks come from a mirrored (selfie) image
  aspect: 4 / 3, // image width / height, so on-screen distances aren't stretched
  tapOn: 0.35, // thumb–index tip distance / palm length (nearer of 3D and on-screen): closed below, open above tapOff
  tapOff: 0.5,
  tapMiddleRatio: 1.2, // thumb at least this many times nearer the index tip than the middle tip
  chopMinPalms: 0.7, // downward fingertip travel, in on-screen palm lengths, within swipeWindowMs
  chopMaxOffAxis: 2.5, // max |dx| / dy: a flick swings the tips in an arc, so allow diagonal
  chopBladeMax: 0.6, // knuckle line's share facing the camera: below = hand edge-on (a blade)
  fingerStraight: 1.5, // fingertip reaches this × its knuckle's distance from the wrist
  chopCooldownMs: 1000,
  waveMinLeg: 0.06, // open-palm wave = undo: each side-to-side leg moves the palm this share of the image width
  waveLegs: 3, // legs (left-right-left) within waveWindowMs
  waveWindowMs: 900, // short, so a swipe and a swipe back a second later are not a wave
};

/** Side-to-side legs of at least `leg` in a run of palm x samples (direction reversals + 1). */
function waveLegs(/** @type {{x: number}[]} */ s, /** @type {number} */ leg) {
  let legs = 0, dir = 0, lo = Infinity, hi = -Infinity, ext = 0;
  for (const { x } of s) {
    if (dir === 0) { // first leg: from the lowest or highest point so far
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
      dir = x - lo >= leg ? 1 : hi - x >= leg ? -1 : 0;
      if (dir) { legs = 1; ext = x; }
    } else if ((x - ext) * dir > 0) ext = x; // still going the same way
    else if (Math.abs(x - ext) >= leg) { dir = -dir; legs++; ext = x; } // reversed far enough
  }
  return legs;
}

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

/** On-screen distance between two landmarks, x scaled by the aspect ratio. */
function imageDist(/** @type {P3[]} */ w, /** @type {number} */ a, /** @type {number} */ b, /** @type {number} */ aspect) {
  return Math.hypot((w[a].x - w[b].x) * aspect, w[a].y - w[b].y);
}

/** Flat straight hand turned edge-on to the camera, like a blade. */
function isBlade(/** @type {P3[]} */ w, /** @type {typeof DEFAULTS} */ c) {
  const straight = FINGERS.every(([m, t]) => len(sub(w[t], w[WRIST])) > c.fingerStraight * len(sub(w[m], w[WRIST])));
  const k = sub(w[PINKY_MCP], w[INDEX_MCP]);
  const l = len(k);
  return straight && l > 1e-9 && Math.hypot(k.x, k.y) / l < c.chopBladeMax;
}

/** Which fingers (index, middle, ring, pinky) are extended, and the pose they make. */
function poseOf(/** @type {P3[]} */ w, /** @type {typeof DEFAULTS} */ c) {
  const out = FINGERS.map(([m, t]) => len(sub(w[t], w[WRIST])) > c.fingerOut * len(sub(w[m], w[WRIST])));
  const n = out.filter(Boolean).length;
  /** @type {Pose} */ const pose = n === 4 ? "open" : n === 0 ? "fist" : n === 1 && out[0] ? "point" : "other";
  return { out, pose };
}

/** Image x/y mapped from the central `box` of the image onto 0–1, x flipped so the user's right is +. */
function toBox(/** @type {number} */ x, /** @type {number} */ y, /** @type {typeof DEFAULTS} */ c) {
  const m = (1 - c.pointerBox) / 2, b = Math.max(1e-9, c.pointerBox);
  const clamp = (/** @type {number} */ v) => Math.min(1, Math.max(0, v));
  const u = clamp((x - m) / b);
  return { x: c.mirrored ? u : 1 - u, y: clamp((y - m) / b) };
}

const round = (/** @type {number} */ v, k = 1e4) => Math.round(v * k) / k;

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
  let horns = false;
  let handedness = "";
  /** @type {P3 | null} */ let neutral = null; // knuckle direction captured at engagement
  let angle = 0; // smoothed twist from neutral, degrees, signed
  let rate = 0;
  let fine = false;
  let detent = 0;
  let cooldownUntil = -Infinity;
  /** @type {{t: number, x: number, y: number, tipX: number, tipY: number, palm: number, blade: boolean}[]} */ let track = [];
  /** @type {{t: number, x: number}[]} */ let wave = []; // open-palm x, for the undo wave
  let waveUntil = -Infinity; // swipes stand down until then: a wave reversed or undid recently
  /** @type {{t: number, direction: "left" | "right"} | null} */ let pendingSwipe = null;
  let tapping = false; // thumb–index closed
  let blade = false; // hand currently chop-ready, for feedback
  let tapRatio = Infinity; // thumb–index closeness, for feedback
  let chopTravel = 0; // fingertip drop so far in the window, palm lengths, for feedback
  let confidence = 0;
  let hornsFingers = 0; // how many of the four 🤘 finger conditions hold, for feedback
  /** @type {Pose | null} */ let pose = null;
  let penDown = false;
  /** @type {{x: number, y: number} | null} */ let pointer = null; // smoothed, while pointing
  /** @type {{x: number, y: number} | null} */ let sentPointer = null;
  let fistSince = -Infinity; // fist pose start, or -Infinity
  let fistX0 = 0, palmX = 0; // palm x (image) at fist close, and smoothed since
  let slide = 0; // last emitted slide offset, seconds

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
    blade = false;
    chopTravel = 0;
    confidence = Number.isFinite(f.hand?.score) ? Number(f.hand?.score) : 0;
    if (h) {
      const palm = len(sub(h.world[MIDDLE_MCP], h.world[WRIST]));
      const pinch = len(sub(h.world[THUMB_TIP], h.world[INDEX_TIP])) / palm;
      const middle = len(sub(h.world[THUMB_TIP], h.world[MIDDLE_TIP])) / palm;
      const fingers = poseOf(h.world, c);
      pose = fingers.pose;
      // 🤘: index and pinky out, middle and ring down. The thumb is ignored (tucked or out both count).
      const [ix, mx, rx, px] = fingers.out;
      hornsFingers = [ix, !mx, !rx, px].filter(Boolean).length;
      horns = hornsFingers === 4;
      // Turned hands hide the fingertips and their depth estimate gets noisy; when the tips touch,
      // their on-screen distance stays small, so take the nearer of the two.
      const imgPalm = Math.max(1e-9, imageDist(h.image, WRIST, MIDDLE_MCP, c.aspect));
      const close = Math.min(pinch, imageDist(h.image, THUMB_TIP, INDEX_TIP, c.aspect) / imgPalm);
      const middleClose = Math.min(middle, imageDist(h.image, THUMB_TIP, MIDDLE_TIP, c.aspect) / imgPalm);
      tapRatio = close;
      const wasTapping = tapping;
      // Thumb–index tap. Not from a fist: curled fingertips bunch up around the thumb.
      tapping = tapping ? close < c.tapOff : close < c.tapOn && middleClose > close * c.tapMiddleRatio && pose !== "fist";
    } else {
      horns = false;
      tapping = false;
      tapRatio = Infinity;
      hornsFingers = 0;
      pose = null;
    }
    // While drawing (pinched), nothing may move the frame under the sketch.
    const engage = (Boolean(f.key) || horns) && !tapping;

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
      return out;
    }

    if (state === "Fist") {
      if (!h || h.handedness !== handedness) {
        state = "TrackingLost";
        out.push({ type: "tracking-lost", t });
      } else if (f.cancel) {
        state = "Cancelled";
        out.push({ type: "cancel", t });
      } else if (pose !== "fist") {
        state = "Idle";
        cooldownUntil = Math.max(cooldownUntil, t + c.quietAfterReleaseMs);
        out.push({ type: "release", t });
      } else {
        // Absolute offset from where the fist closed: no drift, and back to the start is back to 0.
        palmX += c.pointerSmoothing * ((h.image[WRIST].x + h.image[MIDDLE_MCP].x) / 2 - palmX);
        const d = ((c.mirrored ? 1 : -1) * (palmX - fistX0)) / Math.max(1e-9, c.pointerBox);
        const mag = Math.abs(d) - c.slideDeadZone;
        const unit = Math.max(1e-6, c.slideStep);
        const s = mag > 0 ? round(Math.sign(d) * Math.round((mag * c.slideGain) / unit) * unit, 1e3) : 0;
        if (s !== slide) out.push({ type: "slide", t, seconds: s });
        slide = s;
      }
      track = [];
      return out;
    }

    if (state === "TrackingLost" || state === "Cancelled") {
      if (!engage && pose !== "fist") state = "Idle"; // re-engagement requires letting go first
      track = [];
      return out;
    }

    // Idle
    if (pendingSwipe && t - pendingSwipe.t >= c.swipeHoldMs) { // no reversal came: it was a swipe
      out.push({ type: "swipe", t, direction: pendingSwipe.direction });
      pendingSwipe = null;
    }
    const lift = () => { if (penDown) out.push({ type: "pen-up", t }); penDown = false; };
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
      if (engage) track = []; // a dropped frame mid-flick (motion blur) keeps the window
      wave = [];
      lift();
      pointer = sentPointer = null;
      fistSince = -Infinity;
      return out;
    }
    const w = h.image;
    // Pinch = pen: while the thumb holds the index tip the pen is down at the pinch point. Pointing
    // moves the dot with the pen up.
    if (tapping || pose === "point") {
      const tip = tapping ? { x: (w[THUMB_TIP].x + w[INDEX_TIP].x) / 2, y: (w[THUMB_TIP].y + w[INDEX_TIP].y) / 2 } : w[INDEX_TIP];
      const p = toBox(tip.x, tip.y, c);
      const k = c.pointerSmoothing;
      pointer = pointer ? { x: pointer.x + k * (p.x - pointer.x), y: pointer.y + k * (p.y - pointer.y) } : p;
    } else pointer = null;
    if (pointer && (!sentPointer || Math.max(Math.abs(pointer.x - sentPointer.x), Math.abs(pointer.y - sentPointer.y)) >= c.pointerMinMove)) {
      sentPointer = pointer;
      out.push({ type: "pointer", t, x: round(pointer.x), y: round(pointer.y) });
    }
    if (tapping && !penDown) out.push({ type: "pen-down", t });
    if (!tapping) lift();
    penDown = tapping;
    if (!pointer) sentPointer = null;
    // Fist: pause once held.
    if (pose === "fist") {
      if (fistSince === -Infinity) {
        fistSince = t;
        fistX0 = palmX = (w[WRIST].x + w[MIDDLE_MCP].x) / 2;
      }
      if (t - fistSince >= c.fistHoldMs) {
        handedness = h.handedness;
        fistSince = -Infinity;
        slide = 0;
        state = "Fist";
        track = [];
        out.push({ type: "pause", t });
        return out;
      }
    } else fistSince = -Infinity;
    const x = (w[WRIST].x + w[INDEX_MCP].x + w[PINKY_MCP].x) / 3;
    const y = (w[WRIST].y + w[INDEX_MCP].y + w[PINKY_MCP].y) / 3;
    // Open-palm wave = undo (the last stroke, else the last edit).
    if (pose === "open") {
      wave.push({ t, x });
      wave = wave.filter((s) => s.t >= t - c.waveWindowMs);
      const legs = waveLegs(wave, c.waveMinLeg);
      if (legs >= 2) { // the hand reversed: a wave, not a swipe
        pendingSwipe = null;
        waveUntil = t + c.waveWindowMs;
      }
      if (t >= cooldownUntil && legs >= c.waveLegs) {
        out.push({ type: "undo", t });
        cooldownUntil = t + c.swipeCooldownMs;
        waveUntil = t + c.waveWindowMs; // still waving after the undo: no swipes
        wave = [];
        track = [];
        return out;
      }
    } else wave = [];
    // Swipe and chop need an open hand: pointing, fists, pinches and other poses never fire them.
    if (pose !== "open") {
      track = [];
      return out;
    }
    // Fingertips, not the palm: a wrist flick swings the fingers while the palm barely moves.
    const tipX = (w[INDEX_TIP].x + w[MIDDLE_TIP].x) / 2 * c.aspect;
    const tipY = (w[INDEX_TIP].y + w[MIDDLE_TIP].y) / 2;
    blade = isBlade(h.world, c);
    track.push({ t, x, y, tipX, tipY, palm: imageDist(w, WRIST, MIDDLE_MCP, c.aspect), blade });
    track = track.filter((s) => s.t >= t - c.swipeWindowMs);
    const first = track[0];
    if (first?.blade && first.palm > 1e-6) { // in chop pose when the motion began
      const dx = tipX - first.tipX, dy = tipY - first.tipY; // image y grows downward
      chopTravel = dy / first.palm;
      if (t >= cooldownUntil && chopTravel >= c.chopMinPalms && Math.abs(dx) <= c.chopMaxOffAxis * dy) {
        out.push({ type: "chop", t });
        cooldownUntil = t + c.chopCooldownMs; // also blocks swipes from the follow-through
        track = [];
        return out;
      }
    }
    if (t >= cooldownUntil && t >= waveUntil && first) {
      const dx = x - first.x, dy = y - first.y;
      if (Math.abs(dx) >= c.swipeMinDist && Math.abs(dy) <= c.swipeMaxOffAxis * Math.abs(dx)) {
        // Camera faces the user: in an unmirrored image the user's right is image left.
        const right = c.mirrored ? dx > 0 : dx < 0;
        pendingSwipe = { t, direction: right ? "right" : "left" };
        cooldownUntil = t + c.swipeCooldownMs;
        track = [];
      }
    }
    return out;
  }

  /** UI snapshot: mode, effect and confidence must stay visible. */
  const view = () => ({ state, rate, fine, angleDeg: angle, handedness, confidence, horns, hornsFingers, tapping, blade, tapRatio, chopTravel,
    pose, drawing: penDown, penDown, pointer: pointer && { x: round(pointer.x), y: round(pointer.y) } });

  return { step, view };
}

/** Run a recorded trace through a fresh recognizer. @param {Frame[]} frames */
export function replay(frames, config = {}) {
  const r = createRecognizer(config);
  return Array.isArray(frames) ? frames.flatMap((f) => r.step(f)) : [];
}
