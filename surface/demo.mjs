// @ts-check
// Demo page logic that needs no DOM, so it runs under `node --test surface/demo.test.mjs`.

/** Pinch held still (Armed, not twisting) for holdMs = "talk"; letting go = "done"; twisting or losing the hand = "abort". */
export function createHoldToTalk({ holdMs = 800 } = {}) {
  /** @type {number | null} */ let since = null;
  let talking = false;
  return {
    /** @param {number} t @param {{state: string, pinching: boolean}} v @returns {"talk" | "done" | "abort" | null} */
    step(t, v) {
      if (v.state === "Armed" && v.pinching) {
        since ??= t;
        if (!talking && t - since >= holdMs) { talking = true; return "talk"; }
        return null;
      }
      since = null;
      if (!talking) return null;
      talking = false;
      return v.state === "Idle" ? "done" : "abort";
    },
  };
}

// Matches shway/firstcut.ts parseBrief (which still validates) and takes.ts MAX_STATEMENTS.
export const BRIEF_LIMITS = { text: 500, minSec: 5, maxSec: 600, statements: 200 };

/** Form fields → {brief, script} or {error}. brief is firstcut.ts's StoryBrief; script is one statement per line. */
export function readBrief(/** @type {Record<string, unknown>} */ f) {
  const str = (/** @type {unknown} */ v) => (typeof v === "string" ? v.trim() : "");
  const brief = { message: str(f.message), audience: str(f.audience), feeling: str(f.feeling), durationSeconds: Number(f.duration) };
  for (const [k, ask] of /** @type {const} */ ([["message", "what the video should get across"], ["audience", "who it is for"], ["feeling", "how it should feel"]])) {
    if (!brief[k]) return { error: `Say ${ask}.` };
    if (brief[k].length > BRIEF_LIMITS.text) return { error: `${k} is longer than ${BRIEF_LIMITS.text} characters.` };
  }
  if (!Number.isInteger(brief.durationSeconds) || brief.durationSeconds < BRIEF_LIMITS.minSec || brief.durationSeconds > BRIEF_LIMITS.maxSec) {
    return { error: `Duration must be a whole number of seconds, ${BRIEF_LIMITS.minSec}–${BRIEF_LIMITS.maxSec}.` };
  }
  const script = str(f.script).split("\n").map((l) => l.trim()).filter(Boolean);
  if (!script.length) return { error: "Paste the script, one statement per line." };
  if (script.length > BRIEF_LIMITS.statements) return { error: `The script has more than ${BRIEF_LIMITS.statements} statements.` };
  return { brief, script };
}

/**
 * The one pending proposal and its Accept / Reject / Undo, through the adapter. Calls run one at a
 * time; a newer proposal discards the older one. The engine stages one preview at a time, so callers
 * reject the pending one before staging new creator input (show's cancel only cleans up). onChange({pending, status, busy}) after every change.
 * @param {{commit(t: number): Promise<{revision: number, label: string}>, cancel(t: number): Promise<unknown>, undo(): Promise<{undone: string}>}} adapter
 * @param {(s: {pending: {token: number, label: string, source: string} | null, status: string, busy: boolean}) => void} onChange
 */
export function createProposals(adapter, onChange) {
  /** @type {{token: number, label: string, source: string} | null} */ let pending = null;
  let status = "";
  let busy = false;
  const emit = () => onChange({ pending, status, busy });
  /** @param {() => Promise<string>} fn */
  const run = async (fn) => {
    if (busy) return;
    busy = true; emit();
    try { status = await fn(); } catch (e) { status = `Failed: ${e instanceof Error ? e.message : e}`; }
    busy = false; emit();
  };
  return {
    get pending() { return pending; },
    /** source "tribe" = a suggestion: it never displaces a pending proposal, and only the creator accepts it.
     * @param {{token: number, label?: string, source?: string}} p */
    show: (p) => run(async () => {
      if (!Number.isSafeInteger(p?.token)) throw new Error("proposal has no preview token");
      if (p.source === "tribe" && pending) { await adapter.cancel(p.token).catch(() => {}); return "Suggestion skipped: a proposal is already pending."; }
      const old = pending;
      pending = { token: p.token, label: String(p.label ?? "Proposal"), source: p.source ?? "creator" };
      if (old) await adapter.cancel(old.token).catch(() => {}); // already gone is fine
      return ""; // the bar's title already names it
    }),
    accept: () => run(async () => {
      if (!pending) return "Nothing to accept.";
      const r = await adapter.commit(pending.token); // on failure it stays pending so Reject still works
      pending = null;
      return `Accepted: ${r.label} (revision ${r.revision}). Undo reverts it.`;
    }),
    reject: () => run(async () => {
      if (!pending) return "Nothing to reject.";
      const p = pending;
      pending = null; // a token that fails to cancel is gone anyway
      await adapter.cancel(p.token);
      return `Rejected: ${p.label}`;
    }),
    undo: () => run(async () => `Undid: ${(await adapter.undo()).undone}`),
    /** @param {string} s */
    note: (s) => { status = s; emit(); },
  };
}

// ---- TRIBE comparison events ("virtual gestures"). Contract: docs/wiki/inference.md#comparison-events.
// A TRIBE event only ever becomes a suggestion; the creator accepts it like any other preview.

const TEXT = (/** @type {unknown} */ v) => typeof v === "string" && v.length > 0 && v.length <= 128;
const INT = (/** @type {unknown} */ v, min = 0) => typeof v === "number" && Number.isSafeInteger(v) && v >= min;

/**
 * @typedef {{version: 1, id: string, kind: "below-reference" | "above-reference", sequence: number, revision: number,
 *   renderId: string, range: {start: number, end: number}, score: number, reference: string, model: string}} TribeEvent
 * @returns {TribeEvent | null} the event's contract fields, or null when malformed. Unknown fields are ignored.
 */
export function readTribeEvent(/** @type {any} */ v) {
  if (!v || typeof v !== "object" || v.version !== 1 || !TEXT(v.id) || !["below-reference", "above-reference"].includes(v.kind)) return null;
  if (!INT(v.sequence, 1) || !INT(v.revision) || !TEXT(v.renderId) || !TEXT(v.reference) || !TEXT(v.model)) return null;
  const r = v.range;
  if (!r || !INT(r.start) || !INT(r.end) || r.end <= r.start) return null;
  if (typeof v.score !== "number" || !(v.score >= 0 && v.score <= 1)) return null;
  return { version: 1, id: v.id, kind: v.kind, sequence: v.sequence, revision: v.revision, renderId: v.renderId,
    range: { start: r.start, end: r.end }, score: v.score, reference: v.reference, model: v.model };
}

/**
 * When a TRIBE event may become a suggestion: well-formed, made from the timeline as it is now, not seen
 * before, and the creator is neither reviewing a proposal nor mid-gesture/utterance (their input wins).
 * A "busy" drop is not remembered, so the same event can be offered again later.
 */
export function createTribeGate() {
  const seen = new Set();
  return {
    /** @param {unknown} raw @param {{sequence: number | null | undefined, revision: number, pending: boolean, active: boolean}} now
     * @returns {{event: TribeEvent} | {drop: "malformed" | "stale" | "duplicate" | "busy"}} */
    check(raw, now) {
      const e = readTribeEvent(raw);
      if (!e) return { drop: "malformed" };
      if (e.sequence !== now.sequence || e.revision !== now.revision) return { drop: "stale" };
      const same = `${e.renderId} ${e.range.start} ${e.range.end}`;
      if (seen.has(e.id) || seen.has(same)) return { drop: "duplicate" };
      if (now.pending || now.active) return { drop: "busy" };
      if (seen.size > 1000) seen.clear(); // ponytail: bounded memory; a very old event replayed after this is stale by revision anyway
      seen.add(e.id); seen.add(same);
      return { event: e };
    },
  };
}

/** The top video clip under the middle of the range (sequence ticks), or null. */
export function clipAt(/** @type {{video: {items: {clip: number, start: number, duration: number}[]}[]}} */ sequence, /** @type {{start: number, end: number}} */ range) {
  const mid = range.start + Math.floor((range.end - range.start) / 2);
  for (const track of [...sequence.video].reverse()) {
    const c = track.items.find((c) => c.start <= mid && mid < c.start + c.duration);
    if (c) return c.clip;
  }
  return null;
}

/** What the decider is told. Average-viewer prediction, never a measurement of the creator or "engagement". */
export function tribeCorrection(/** @type {TribeEvent} */ e, feeling = "") {
  return `The predicted average-viewer response for this line (TRIBE model; not a measurement of anyone, not engagement or quality) ` +
    `is ${e.kind === "below-reference" ? "below" : "above"} the creator's approved reference pattern. ` +
    `Choose another take of the same line only if it plausibly fits the brief${feeling ? ` (feeling: ${JSON.stringify(feeling)})` : ""} better; ` +
    `if nothing clearly fits, answer -1.`;
}

/** Dynamically imports a panel hook module; null with a reason if it isn't built yet. */
export async function loadHook(/** @type {string} */ url, /** @type {string[]} */ names) {
  try {
    const m = await import(url);
    const missing = names.filter((n) => typeof m[n] !== "function");
    return missing.length ? { error: `${url} lacks ${missing.join(", ")}` } : { module: m };
  } catch {
    return { error: "not available yet" };
  }
}
