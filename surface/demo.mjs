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
 * time; a newer proposal discards the older one. onChange({pending, status, busy}) after every change.
 * @param {{commit(t: number): Promise<{revision: number, label: string}>, cancel(t: number): Promise<unknown>, undo(): Promise<{undone: string}>}} adapter
 * @param {(s: {pending: {token: number, label: string} | null, status: string, busy: boolean}) => void} onChange
 */
export function createProposals(adapter, onChange) {
  /** @type {{token: number, label: string} | null} */ let pending = null;
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
    /** @param {{token: number, label?: string}} p */
    show: (p) => run(async () => {
      if (!Number.isSafeInteger(p?.token)) throw new Error("proposal has no preview token");
      const old = pending;
      pending = { token: p.token, label: String(p.label ?? "Proposal") };
      if (old) await adapter.cancel(old.token).catch(() => {}); // already gone is fine
      return `Previewing: ${pending.label}`;
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
