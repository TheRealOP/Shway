// @ts-check
// Gesture events → editor calls through the Shway adapter (shway/adapter.ts). No engine access
// beyond the adapter's typed methods; the recognizer stays editor-agnostic.

/**
 * @typedef {{
 *   shuttle(speed: number): Promise<unknown>, stop(): Promise<unknown>, togglePlay(): Promise<unknown>,
 *   stepFrames(frames: number): Promise<unknown>, playhead(): Promise<number>, seekTicks(t: number): Promise<unknown>,
 *   nextEdit(): Promise<unknown>, prevEdit(): Promise<unknown>, cut(): Promise<unknown>,
 * }} GestureAdapter
 */

/**
 * @param {GestureAdapter} adapter
 * @param {{onError?: (e: unknown, event: {type: string}) => void}} [opts]
 * @returns {(event: import("./recognizer.mjs").GestureEvent) => Promise<void>}
 */
export function createBridge(adapter, { onError } = {}) {
  let queue = Promise.resolve();
  /** @type {number | null} */ let engagedAt = null; // playhead (ticks) to restore on cancel
  /** @type {number | null} */ let rate = null; // latest shuttle rate not yet sent

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
      case "double-tap":
        return run(e, () => adapter.togglePlay());
      default:
        return queue;
    }
  };
}
