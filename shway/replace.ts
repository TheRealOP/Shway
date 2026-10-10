// DEV-92: a spoken creative correction on the selected clip becomes a previewed, reversible
// take replacement. Target = the visible selection (never guessed); Gemini only picks among
// indexed takes of the same statement; Rust stages the edit. Accept = adapter.commit(token),
// reject = adapter.cancel(token), undo after accept = adapter.undo() (one step).
import {TICKS_PER_SECOND} from "./takes.ts";
import type {Take} from "./takes.ts";
import type {ClipInspection, EditProposal, ProposalPreview, ReplaceStep, SequenceInspection, ShwayAdapter, TrimStep} from "./adapter.ts";

/** Calls the model with a response schema and resolves to the parsed JSON (see geminiGenerate). */
export type Generate = (request: {prompt: string; system?: string; schema?: Record<string, unknown>}) => Promise<unknown>;
export interface ReplacementContext {revision: number; sequence: number; selection: number[]}
export interface ReplacementInput {
  utterance?: {transcript?: {text: string} | null; context?: unknown} | null;
  transcript?: string;           // defaults to utterance.transcript.text
  context?: ReplacementContext;  // defaults to utterance.context (snapshot at push-to-talk start)
  takes: Take[];
  generate: Generate;
  adapter: Pick<ShwayAdapter, "inspect" | "preview" | "cancel">;
}
export type ReplacementResult =
  | {status: "preview"; token: number; label: string; preview: ProposalPreview; explanation: string; from: Take; take: Take; proposal: EditProposal}
  | {status: "need-selection"; message: string} // no, several or unknown clips selected: ask, don't guess
  | {status: "no-take"; message: string}        // selection not in the take index, or no alternative take
  | {status: "rejected"; message: string};      // unusable transcript or model answer, or unexpected staging

const MAX_TRANSCRIPT = 2000;
const SCHEMA = {
  type: "OBJECT",
  properties: {take: {type: "INTEGER"}, explanation: {type: "STRING"}},
  required: ["take", "explanation"],
};
const SYSTEM = "You are a film editor's assistant. The editor selected one take of a scripted line and spoke a creative correction. " +
  "Choose the alternative take that best satisfies the correction, using only the listed takes. Bracketed words such as [laughs] are non-speech sounds. " +
  "Answer with the take number and one short sentence explaining the choice. If no listed take satisfies the correction, answer take -1.";

const safe = (v: unknown, min = 0): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min;
const words = (t: Take) => t.words.map(w => w.text).join(" ");
const allClips = (q: SequenceInspection) => [...q.video, ...q.audio].flatMap(t => t.items);

function readContext(value: unknown): ReplacementContext | null {
  const c = value as Partial<ReplacementContext> | null;
  if (!c || typeof c !== "object" || !safe(c.revision, 1) || !safe(c.sequence, 1) || !Array.isArray(c.selection) || c.selection.length > 32 || !c.selection.every(id => safe(id, 1))) return null;
  return {revision: c.revision, sequence: c.sequence, selection: [...new Set(c.selection)]};
}

/** One clip, or exactly its linked A/V pair; anything else needs an explicit selection. */
function target(sequence: SequenceInspection, selection: number[]): ClipInspection | string {
  if (selection.length === 0) return "Select the clip you mean, then say it again.";
  const clips = allClips(sequence);
  const picked = selection.map(id => clips.find(c => c.clip === id));
  if (picked.some(c => !c)) return "The selected clip is no longer in the sequence; select it again.";
  const [first, second] = picked as ClipInspection[];
  if (picked.length === 1) return first;
  const linked = picked.length === 2 && first.link != null && first.link === second.link && first.item === second.item;
  if (!linked) return "Several clips are selected; select the one take you mean.";
  return sequence.video.some(t => t.items.includes(first)) ? first : second;
}

/** The indexed take that overlaps the clip's source range most. */
function currentTake(takes: Take[], clip: ClipInspection): Take | null {
  let best: Take | null = null, bestOverlap = 0;
  for (const t of takes) {
    if (t.sourceItemId !== clip.item) continue;
    const overlap = Math.min(t.sourceOut, clip.sourceOut) - Math.max(t.sourceIn, clip.sourceIn);
    if (overlap > bestOverlap) {best = t; bestOverlap = overlap;}
  }
  return best;
}

function labelFor(take: Take): string {
  let text = words(take);
  if (text.length > 60) text = text.slice(0, 59) + "…";
  return `Replace take: "${text}"`;
}

/**
 * Exact source-range steps. Current clip plays [base, base + d) frames of its source (base in ticks);
 * the result plays [a, e) frames relative to base. Two ripple trims slip and resize in place; the
 * order keeps every intermediate range non-empty.
 */
function slip(clip: number, source: number, d: number, a: number, e: number): TrimStep[] {
  const trim = (edge: "in" | "out", deltaFrames: number): TrimStep[] =>
    deltaFrames === 0 ? [] : [{command: "timeline.trim", params: {clip, source, edge, mode: "ripple", deltaFrames}}];
  return e > 0 ? [...trim("out", e - d), ...trim("in", a)] : [...trim("in", a), ...trim("out", e - d)];
}

export async function proposeReplacement(input: ReplacementInput): Promise<ReplacementResult> {
  const {utterance, takes, generate, adapter} = input;
  const text = (input.transcript ?? utterance?.transcript?.text ?? "").trim();
  if (!text || text.length > MAX_TRANSCRIPT) return {status: "rejected", message: "No usable transcript for this utterance."};
  const context = readContext(input.context ?? utterance?.context);
  if (!context) return {status: "need-selection", message: "No interaction context was captured; select a clip and try again."};
  if (!Array.isArray(takes)) return {status: "no-take", message: "No take index is loaded."};

  const {sequence} = await adapter.inspect();
  if (!sequence || sequence.id !== context.sequence) return {status: "need-selection", message: "The active sequence changed; select the clip again."};
  const clip = target(sequence, context.selection);
  if (typeof clip === "string") return {status: "need-selection", message: clip};
  const from = currentTake(takes, clip);
  if (!from) return {status: "no-take", message: "The selected clip does not match any indexed take."};
  const candidates = takes.filter(t => t.statementIndex === from.statementIndex);
  const current = candidates.indexOf(from);
  if (candidates.length < 2) return {status: "no-take", message: "There is no other take of this line."};

  // Takes go to the model as opaque indices with their words; never IDs or times.
  const prompt = `Spoken correction: ${JSON.stringify(text)}\n\nTakes of the selected line:\n` +
    candidates.map((t, i) => `${i}${i === current ? " (current)" : ""}: ${JSON.stringify(words(t))}`).join("\n");
  const answer = await generate({prompt, system: SYSTEM, schema: SCHEMA}) as {take?: unknown; explanation?: unknown} | null;
  const choice = answer?.take;
  const explanation = typeof answer?.explanation === "string" ? answer.explanation.trim().slice(0, 300) : "";
  if (choice === -1) return {status: "rejected", message: explanation || "No take matches that correction."};
  if (!safe(choice) || choice >= candidates.length) return {status: "rejected", message: "The model chose a take that does not exist; nothing was changed."};
  if (choice === current) return {status: "rejected", message: "The model chose the take already in the timeline; nothing was changed."};
  const take = candidates[choice];

  const rate = (sequence.settings as {frame_rate?: {num?: unknown; den?: unknown}} | undefined)?.frame_rate;
  const frame = safe(rate?.num, 1) && safe(rate?.den, 1) ? TICKS_PER_SECOND * rate.den / rate.num : NaN;
  if (!safe(frame, 1) || clip.duration % frame !== 0) return {status: "rejected", message: "The sequence frame rate does not divide engine ticks exactly; this replacement is unsupported."};
  let d = clip.duration / frame;
  const steps: (TrimStep | ReplaceStep)[] = [];
  // ponytail: assumes the replacement item has no source In mark (project.inspect does not expose marks);
  // the staged-range check below cancels the preview if the engine started elsewhere.
  const base = take.sourceItemId === clip.item ? clip.sourceIn : 0;
  const a = Math.floor((take.sourceIn - base) / frame), e = Math.ceil((take.sourceOut - base) / frame);
  if (take.sourceItemId !== clip.item) {
    // Shorten first so the replacement only has to cover the new take's length.
    if (e - a < d) {steps.push({command: "timeline.trim", params: {clip: clip.clip, source: clip.item, edge: "out", mode: "ripple", deltaFrames: e - a - d}}); d = e - a;}
    steps.push({command: "clip.replaceFromBin", params: {clips: [clip.clip], item: take.sourceItemId}});
  }
  steps.push(...slip(clip.clip, take.sourceItemId, d, a, e));
  const proposal: EditProposal = {expectedRevision: context.revision, sequence: context.sequence, label: labelFor(take), steps};

  // Engine errors (stale revision, short media, missing handles) propagate unchanged for re-planning.
  const preview = await adapter.preview(proposal);
  const staged = allClips(preview.sequence).find(c => c.clip === clip.clip);
  if (!staged || staged.item !== take.sourceItemId || staged.sourceIn !== base + a * frame || staged.duration !== (e - a) * frame) {
    await adapter.cancel(preview.token);
    return {status: "rejected", message: "The engine staged a different source range than the chosen take; nothing was changed."};
  }
  return {status: "preview", token: preview.token, label: preview.label, preview, explanation, from, take, proposal};
}

/** A Generate backed by the local Gemini proxy (shway/gemini-server.mjs). */
export function geminiGenerate(base = "http://127.0.0.1:8790"): Generate {
  return async request => {
    const response = await fetch(`${base}/generate`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(request)});
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || !("json" in body)) throw new Error(`Gemini proxy: ${body?.error ?? response.status}`);
    return body.json;
  };
}

/** Transcribe a push-to-talk recording through the local proxy. Resolves to {text}. */
export async function transcribe(audio: Blob, base = "http://127.0.0.1:8790"): Promise<{text: string}> {
  const bytes = new Uint8Array(await audio.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const response = await fetch(`${base}/transcribe`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({mimeType: audio.type || "audio/webm", data: btoa(binary)})});
  const body = await response.json().catch(() => null);
  if (!response.ok || typeof body?.text !== "string") throw new Error(`Transcription: ${body?.error ?? response.status}`);
  return {text: body.text.trim()};
}
