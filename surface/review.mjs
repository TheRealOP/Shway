// @ts-check
// Review remote logic (DEV-113), DOM-free: `node --test surface/review.test.mjs`. review.html owns the
// camera and microphone; this turns push-to-talk and gestures into shway/assistant.mjs calls.
// Push-to-talk start IS the stop, so playback audio (only recorded while talk is held) can never stop it.

/** A leading "stop" is the stop itself, not part of the note: "Stop. This bit drags" → "This bit drags". */
export const noteText = (/** @type {unknown} */ s) => String(s ?? "").replace(/^\s*stop\b[\s,.!?;:-]*/i, "").trim();

const TRANSPORT = new Set(["engage", "shuttle", "step", "release", "cancel", "tracking-lost", "swipe", "pause", "slide"]);
const MAX_STROKES = 20, MAX_POINTS = 500; // same caps as the assistant's POST /ink

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

/**
 * Latest-wins POST /ink at most every `minGapMs` (≤ 30 Hz), one request in flight; states queued meanwhile
 * collapse to the newest, so stale ink is dropped. Returns send(ink) → a promise for when it settles.
 * @param {(path: string, body?: object) => Promise<any>} post
 */
export function createInkSender(post, { minGapMs = 1000 / 30, now = () => performance.now(), onError = (/** @type {any} */ _e) => {} } = {}) {
  /** @type {object | null} */ let latest = null;
  let busy = false, last = -Infinity;
  /** @type {Promise<void> | null} */ let waiting = null;
  const pump = async () => {
    while (latest && !busy) {
      const wait = last + minGapMs - now();
      if (wait > 0) { await (waiting ??= new Promise((r) => setTimeout(() => { waiting = null; r(); }, wait))); continue; }
      const body = latest;
      latest = null; busy = true; last = now();
      try { await post("/ink", body); } catch (e) { onError(e); } finally { busy = false; }
    }
  };
  return (/** @type {object} */ ink) => { latest = ink; return pump(); };
}

/** JSON POST to the assistant; resolves the reply body, rejects with the server's error text. */
export const poster = (/** @type {string} */ base) => async (/** @type {string} */ path, body = {}) => {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const b = await r.json().catch(() => null);
  if (!r.ok) throw new Error(b?.error ?? `HTTP ${r.status}`);
  return b;
};

/** Gemini proxy POST /transcribe (shway/gemini-server.mjs); same request as shway/replace.ts transcribe(). */
export async function transcribe(/** @type {Blob} */ audio, base = "http://127.0.0.1:8790") {
  const bytes = new Uint8Array(await audio.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return (await poster(base)("/transcribe", { mimeType: audio.type || "audio/webm", data: btoa(bin) })).text?.trim() ?? "";
}

/**
 * Every call goes through one queue, so a scrub sent before a note reaches the editor before the
 * note reads the playhead. Methods resolve to a status line for the page and never reject.
 * @param {(path: string, body?: object) => Promise<any>} post
 */
export function createReview(post) {
  /** @type {Promise<unknown>} */ let queue = Promise.resolve();
  /** @type {Promise<any> | null} */ let stopping = null;
  /** @type {number | null} */ let slideNext = null;
  const fail = (/** @type {any} */ e) => `Failed: ${e?.message ?? e}`;
  const serial = (/** @type {() => Promise<any>} */ fn) => { const p = queue.then(fn); queue = p.catch(() => {}); return p; };
  const at = (/** @type {any} */ m) => `${(m.playhead / 254016000000).toFixed(2)} s${m.clip != null ? `, clip ${m.clip}` : ""} (rev ${m.revision})`;
  return {
    /** Push-to-talk started (V key or button): pause and capture the moment. */
    stop() {
      stopping = serial(() => post("/review/stop"));
      return stopping.then((r) => `Stopped at ${at(r.moment)}. Explain what to change.`, fail);
    },
    /** What was said while talk was held, plus the gestures in its window. */
    async note(/** @type {string} */ transcript, /** @type {{type: string}[]} */ gestures = []) {
      const text = noteText(transcript);
      const m = await stopping?.catch(() => null);
      if (!m?.moment) return "No moment captured: hold to talk again.";
      if (!text) return `Stopped at ${at(m.moment)}. Hold to talk to explain, or Resume.`;
      const g = gestures.filter((e) => typeof e?.type === "string").slice(-64).map((e) => ({ type: e.type }));
      return serial(() => post("/review/note", { moment: m.moment, transcript: text.slice(0, 2000), gestures: g }))
        .then((r) => `${r.reply}${r.pending ? " Accept or reject it in the editor's chat panel." : ""}`, fail);
    },
    /** Cancel (Esc / Resume): resume playback from the stopped moment. */
    cancel: () => { stopping = null; return serial(() => post("/review/cancel")).then(() => "Resumed.", fail); },
    /** Recognizer event: transport goes to the bridge, chop to the cut route (DEV-114), others are ignored. */
    gesture(/** @type {any} */ e) {
      const type = e?.type;
      if (type === "chop") return serial(() => post("/review/cut")).then((r) => r?.reply ?? "Cut requested.", fail);
      if (!TRANSPORT.has(type)) return Promise.resolve("");
      if (type === "slide") { // frame-rate offsets: one queued at a time, carrying the newest value
        const queued = slideNext !== null;
        slideNext = e.seconds;
        if (queued) return Promise.resolve("");
        return serial(() => { const seconds = slideNext; slideNext = null; return post("/review/transport", { event: { type, seconds } }); }).then(() => "", fail);
      }
      const event ={ type, ...(type === "shuttle" && { rate: e.rate }), ...(type === "step" && { frames: e.frames }), ...(type === "swipe" && { direction: e.direction }) };
      return serial(() => post("/review/transport", { event })).then(() => "", fail);
    },
  };
}
