// @ts-check
// Review remote logic (DEV-113), DOM-free: `node --test surface/review.test.mjs`. review.html owns the
// camera and microphone; this turns push-to-talk and gestures into shway/assistant.mjs calls.
// Push-to-talk start IS the stop, so playback audio (only recorded while talk is held) can never stop it.

/** A leading "stop" is the stop itself, not part of the note: "Stop. This bit drags" → "This bit drags". */
export const noteText = (/** @type {unknown} */ s) => String(s ?? "").replace(/^\s*stop\b[\s,.!?;:-]*/i, "").trim();

const TRANSPORT = new Set(["engage", "shuttle", "step", "release", "cancel", "tracking-lost", "swipe", "double-tap"]);

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
  const fail = (/** @type {any} */ e) => `Failed: ${e?.message ?? e}`;
  const serial = (/** @type {() => Promise<any>} */ fn) => { const p = queue.then(fn); queue = p.catch(() => {}); return p; };
  const at = (/** @type {any} */ m) => `${(m.playhead / 254016000000).toFixed(2)} s${m.clip != null ? `, clip ${m.clip}` : ""} (rev ${m.revision})`;
  return {
    /** Push-to-talk started (key, button or still pinch): pause and capture the moment. */
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
      const event = { type, ...(type === "shuttle" && { rate: e.rate }), ...(type === "step" && { frames: e.frames }), ...(type === "swipe" && { direction: e.direction }) };
      return serial(() => post("/review/transport", { event })).then(() => "", fail);
    },
  };
}
