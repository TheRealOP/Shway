// @ts-check
// Gesture events → editor calls through the Shway adapter (shway/adapter.ts). No engine access
// beyond the adapter's typed methods; the recognizer stays editor-agnostic. createInk turns the
// pointer/pen events into the Program monitor's ink (`ui.set {ink}`); shway/assistant.mjs --camera uses both.

/**
 * @typedef {{
 *   shuttle(speed: number): Promise<unknown>, stop(): Promise<unknown>,
 *   stepFrames(frames: number): Promise<unknown>, playhead(): Promise<number>, seekTicks(t: number): Promise<unknown>,
 *   nextEdit(): Promise<unknown>, prevEdit(): Promise<unknown>, cut(): Promise<unknown>,
 * }} GestureAdapter
 */

/**
 * @param {GestureAdapter} adapter
 * @param {{onError?: (e: unknown, event: {type: string}) => void}} [opts]
 * @returns {(event: import("./recognizer.mjs").GestureEvent) => Promise<void>}
 */
const TPS = 254016000000; // filmcraft_time ticks per second

export function createBridge(adapter, { onError } = {}) {
  let queue = Promise.resolve();
  /** @type {number | null} */ let engagedAt = null; // playhead (ticks) at engage / pause: cancel restores it, slide is relative to it
  /** @type {number | null} */ let rate = null; // latest shuttle rate not yet sent
  /** @type {number | null} */ let slide = null; // latest slide offset (s) not yet sent

  // Calls run one at a time, in order; a failure is reported and the queue carries on.
  const run = (/** @type {{type: string}} */ e, /** @type {() => Promise<unknown>} */ fn) =>
    (queue = queue.then(fn).then(() => {}, (err) => onError?.(err, e)));

  return (e) => {
    switch (e?.type) {
      case "engage":
        engagedAt = null;
        return run(e, async () => { engagedAt = await adapter.playhead(); });
      case "shuttle":
        rate = e.rate;
        // Latest wins: queued updates collapse so playback isn't restarted for stale speeds.
        return run(e, async () => {
          const r = rate;
          rate = null;
          if (r === null) return;
          await (r === 0 ? adapter.stop() : adapter.shuttle(r));
        });
      case "pause":
        engagedAt = null;
        return run(e, async () => { await adapter.stop(); engagedAt = await adapter.playhead(); });
      case "slide":
        slide = e.seconds;
        // Latest wins, like shuttle. A seek moves the playhead only: no undo entry.
        return run(e, async () => {
          const s = slide;
          slide = null;
          if (s === null || engagedAt === null || !Number.isFinite(s)) return;
          await adapter.seekTicks(Math.max(0, Math.round(engagedAt + s * TPS)));
        });
      case "step":
        return run(e, () => adapter.stepFrames(e.frames));
      case "cancel":
        return run(e, async () => {
          if (engagedAt !== null) await adapter.seekTicks(engagedAt);
          engagedAt = null;
        });
      case "release":
      case "tracking-lost": // the recognizer already sent shuttle 0
        return run(e, async () => { engagedAt = null; });
      case "swipe":
        return run(e, () => (e.direction === "right" ? adapter.nextEdit() : adapter.prevEdit()));
      case "chop":
        return run(e, () => adapter.cut());
      default:
        return queue;
    }
  };
}

const MAX_STROKES = 20, MAX_POINTS = 500; // the editor's caps (state::Ink)

/** The sketch on the Program monitor, built from recognizer ink events: {pointer, strokes, drawing}, 0–1 frame coords. */
export function createInk() {
  /** @type {[number, number] | null} */ let pointer = null;
  /** @type {[number, number][][]} */ let strokes = [];
  let drawing = false, pen = false;
  const clear = () => { strokes = []; drawing = pen = false; return true; };
  return {
    /** Applies one recognizer event; true when the ink changed. A new drawing replaces the old sketch; cancel (Esc) clears it. */
    event(/** @type {any} */ e) {
      switch (e?.type) {
        case "pointer": {
          pointer = [e.x, e.y];
          const s = strokes.at(-1);
          if (pen && s && s.length < MAX_POINTS) s.push(pointer);
          return true;
        }
        case "pen-down":
          pen = true;
          strokes.push(pointer ? [pointer] : []);
          if (strokes.length > MAX_STROKES) strokes.shift();
          return true;
        case "pen-up": pen = false; return false;
        case "draw-toggle": drawing = e.drawing === true; pen = false; if (drawing) strokes = []; return true;
        case "cancel": return clear();
        default: return false;
      }
    },
    /** The dot shows only while pointing: pass recognizer.view().pointer !== null each frame. */
    visible(/** @type {boolean} */ on) { if (on || !pointer) return false; pointer = null; return true; },
    clear,
    state: () => ({ pointer, strokes: strokes.filter((s) => s.length), drawing }),
  };
}
