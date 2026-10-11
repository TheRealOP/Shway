// @ts-check
// Shway push-to-talk utterances (DEV-92 voice capture). Pure and deterministic: no microphone,
// DOM, clock or editor access. The caller passes times (ms) and the interaction context; this
// module decides when an utterance exists. Audio is only ever an utterance between an explicit
// start (key / gesture / button) and stop, so playback audio cannot become a command.

/**
 * @typedef {{t: number, type: string, [k: string]: unknown}} GestureEvent  // from surface/gestures
 * @typedef {{
 *   id: string,
 *   source: "key" | "gesture" | "button",
 *   startT: number,
 *   endT: number,
 *   capped: boolean,         // stopped by maxMs, not by release
 *   context: unknown,        // snapshot of the caller's context at start (selection, target, playhead, gesture state)
 *   gestures: GestureEvent[],// gesture events within [startT - preMs, endT]
 *   audio: unknown,          // caller attaches the recorded Blob (or a ref); null until then
 *   transcript: {text: string, words?: unknown[]} | null, // null until a provider fills it
 * }} Utterance
 * @typedef {{type: "recording", id: string, t: number}
 *   | {type: "utterance", utterance: Utterance}
 *   | {type: "cancelled", id: string, t: number}
 *   | {type: "rejected", reason: string, t: number}} VoiceEvent
 */

export const DEFAULTS = {
  key: "KeyV",      // KeyboardEvent.code held for push-to-talk
  minMs: 300,       // shorter holds are accidental taps: rejected
  maxMs: 15000,     // longer holds are cut here (a stuck key must not record forever)
  preMs: 2000,      // gestures this long before start still belong to the utterance
  maxGestures: 64,  // gesture buffer bound
};
const SOURCES = ["key", "gesture", "button"];

/** @param {Partial<typeof DEFAULTS>} [config] */
export function createVoice(config = {}) {
  const c = { ...DEFAULTS };
  for (const k of /** @type {(keyof typeof DEFAULTS)[]} */ (Object.keys(DEFAULTS))) {
    const v = /** @type {any} */ (config)?.[k];
    if (k === "key") { if (typeof v === "string" && v) c.key = v; }
    else if (Number.isFinite(v) && v >= 0) /** @type {any} */ (c)[k] = v;
  }
  if (c.minMs > c.maxMs) c.minMs = c.maxMs;
  c.maxGestures = Math.min(Math.floor(c.maxGestures), 1024);

  let last = -Infinity; // latest accepted time; time never runs backwards
  let n = 0;
  /** @type {null | {id: string, source: Utterance["source"], startT: number, context: unknown}} */
  let rec = null;
  /** @type {GestureEvent[]} */
  let gestures = [];
  let lastG = -Infinity; // gesture times are monotonic among themselves (separate source)

  /** @param {unknown} t */
  const okTime = (t) => typeof t === "number" && Number.isFinite(t) && t >= last;
  /** @param {string} reason @param {unknown} t @returns {VoiceEvent} */
  const reject = (reason, t) => ({ type: "rejected", reason, t: Number.isFinite(t) ? /** @type {number} */ (t) : NaN });

  /** @param {number} endT @param {boolean} capped @returns {VoiceEvent} */
  function finish(endT, capped) {
    const r = /** @type {NonNullable<typeof rec>} */ (rec);
    rec = null;
    if (!capped && endT - r.startT < c.minMs) return reject("too-short", endT);
    const from = r.startT - c.preMs;
    return { type: "utterance", utterance: {
      id: r.id, source: r.source, startT: r.startT, endT, capped, context: r.context,
      gestures: gestures.filter((g) => g.t >= from && g.t <= endT), audio: null, transcript: null,
    } };
  }

  return {
    config: c,
    /** Begin recording. `context` is snapshotted now, so later selection changes don't leak in.
     * @param {number} t @param {unknown} [context] @param {Utterance["source"]} [source] @returns {VoiceEvent} */
    start(t, context = null, source = "button") {
      if (!okTime(t)) return reject("bad-time", t);
      if (!SOURCES.includes(source)) return reject("bad-source", t);
      if (rec) return reject("already-recording", t);
      let snap;
      try { snap = structuredClone(context ?? null); } catch { return reject("bad-context", t); }
      last = t;
      rec = { id: `u${++n}`, source, startT: t, context: snap };
      return { type: "recording", id: rec.id, t };
    },
    /** End recording (push-to-talk released). @param {number} t @returns {VoiceEvent} */
    stop(t) {
      if (!okTime(t)) return reject("bad-time", t);
      if (!rec) return reject("not-recording", t);
      last = t;
      const cap = rec.startT + c.maxMs;
      return t > cap ? finish(cap, true) : finish(t, false);
    },
    /** Discard the recording in progress. @param {number} t @returns {VoiceEvent} */
    cancel(t) {
      if (!rec) return reject("not-recording", t);
      const id = rec.id;
      rec = null;
      if (okTime(t)) last = t;
      return { type: "cancelled", id, t: Number.isFinite(t) ? t : last };
    },
    /** Call regularly while recording; ends the utterance once maxMs is reached. @param {number} t @returns {VoiceEvent | null} */
    tick(t) {
      if (!okTime(t) || !rec) return null;
      last = t;
      return t >= rec.startT + c.maxMs ? finish(rec.startT + c.maxMs, true) : null;
    },
    /** Push-to-talk key: down starts, up stops; other keys and key repeat are ignored.
     * @param {number} t @param {string} code @param {boolean} down @param {unknown} [context] @returns {VoiceEvent | null} */
    key(t, code, down, context) {
      if (code !== c.key) return null;
      if (down) return rec ? null : this.start(t, context, "key");
      return rec?.source === "key" ? this.stop(t) : null;
    },
    /** Record a gesture event for association. Malformed or out-of-order events are dropped.
     * @param {unknown} e */
    gesture(e) {
      const g = /** @type {any} */ (e);
      if (!g || typeof g !== "object" || typeof g.type !== "string" || !Number.isFinite(g.t) || g.t < lastG) return;
      lastG = g.t;
      gestures = gestures.filter((x) => x.t >= g.t - c.preMs - c.maxMs);
      gestures.push({ ...g });
      if (gestures.length > c.maxGestures) gestures.shift();
    },
    /** @returns {{recording: boolean, id: string | null, startT: number | null}} */
    view() { return { recording: !!rec, id: rec?.id ?? null, startT: rec?.startT ?? null, source: rec?.source ?? null }; },
  };
}
