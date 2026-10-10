// Provider-neutral word-timed transcripts and a deterministic script-to-take index.
// Times leave this module only as exact engine ticks; source item IDs are media IDs, never clip IDs.
export const TICKS_PER_SECOND = 254_016_000_000;
export const MAX_WORDS = 20_000;
export const MAX_WORD_LENGTH = 100;
export const MAX_STATEMENTS = 200;
export const MAX_STATEMENT_WORDS = 64;
export const MAX_SOURCES = 64;
export const MAX_INDEX_WORK = 5_000_000;

export interface TranscriptWordInput {text: string; start: number; end: number; confidence?: number}
// One recorded source. `timeUnit` names how start/end are written; there is no default.
export interface TranscriptInput {
  sourceItemId: number;
  timeUnit: "seconds" | "ticks";
  language?: string;
  words: TranscriptWordInput[];
}
export interface TickWord {text: string; start: number; end: number; confidence?: number}
export interface SourceTranscript {sourceItemId: number; language: string; words: TickWord[]}
export interface Take {
  sourceItemId: number;
  sourceIn: number;
  sourceOut: number;
  words: TickWord[];
  statementIndex: number;
  score: number;
}

export class TranscriptError extends Error {
  constructor(message: string) {super(message); this.name = "TranscriptError";}
}
function fail(message: string): never {throw new TranscriptError(message);}
function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function only(value: Record<string, unknown>, allowed: string[], name: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${name}: unsupported field ${key}`);
}
function ticks(value: unknown, unit: "seconds" | "ticks", name: string): number {
  if (typeof value !== "number" || value < 0) fail(`${name} must be a number >= 0`);
  // NaN, Infinity, fractional ticks and overflowing seconds all fail the exact-integer check.
  const t = unit === "ticks" ? value : Math.round(value * TICKS_PER_SECOND);
  if (!Number.isSafeInteger(t)) fail(`${name} must be finite and convert to exact safe-integer ticks`);
  return t;
}

/** Lower-case and trim punctuation from both ends, like the engine's `normalize_word`. */
export function normalizeToken(text: string): string {
  return text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();
}

/**
 * Validate hostile transcript input and convert it to exact ticks. Words must be non-empty,
 * ordered and non-overlapping; `sourceDuration` (ticks), when known, bounds every word end.
 */
export function parseTranscript(value: unknown, sourceDuration?: number): SourceTranscript {
  const input = record(value, "transcript");
  only(input, ["sourceItemId", "timeUnit", "language", "words"], "transcript");
  const sourceItemId = input.sourceItemId;
  if (typeof sourceItemId !== "number" || !Number.isSafeInteger(sourceItemId) || sourceItemId < 1) fail("sourceItemId must be a safe integer >= 1");
  const unit = input.timeUnit;
  if (unit !== "seconds" && unit !== "ticks") fail("timeUnit must be seconds or ticks");
  const language = input.language ?? "";
  if (typeof language !== "string" || !/^([a-z]{2,3}(-[A-Za-z0-9]{1,8})?)?$/.test(language)) fail("language must be an ISO 639 code such as en");
  if (sourceDuration !== undefined && (!Number.isSafeInteger(sourceDuration) || sourceDuration < 0)) fail("source duration must be safe integer ticks");
  if (!Array.isArray(input.words) || input.words.length === 0 || input.words.length > MAX_WORDS) fail(`transcript requires 1–${MAX_WORDS} words`);
  let previousEnd = 0;
  const words = Array.from(input.words, (value, i): TickWord => {
    const word = record(value, `words[${i}]`);
    only(word, ["text", "start", "end", "confidence"], `words[${i}]`);
    const text = word.text;
    if (typeof text !== "string" || text.length > MAX_WORD_LENGTH || !text.trim()) fail(`words[${i}].text requires 1–${MAX_WORD_LENGTH} characters`);
    const start = ticks(word.start, unit, `words[${i}].start`), end = ticks(word.end, unit, `words[${i}].end`);
    if (end < start) fail(`words[${i}] ends before it starts`);
    if (start < previousEnd) fail(`words[${i}] overlaps or precedes the previous word`);
    if (sourceDuration !== undefined && end > sourceDuration) fail(`words[${i}] ends after the source duration`);
    previousEnd = end;
    const out: TickWord = {text: text.trim(), start, end};
    if (word.confidence !== undefined) {
      const c = word.confidence;
      if (typeof c !== "number" || !Number.isFinite(c) || c < 0 || c > 1) fail(`words[${i}].confidence must be within 0..1`);
      out.confidence = c;
    }
    return out;
  });
  return {sourceItemId, language, words};
}

/**
 * Group transcript ranges into takes per script statement. For each start word, the best window
 * (up to 1.25× the statement length) is scored by Dice token overlap; windows at or above
 * `minScore` are accepted greedily by score without overlapping another accepted take.
 */
export function indexTakes(transcripts: SourceTranscript[], script: string[], minScore = 0.6): Take[] {
  if (!Array.isArray(transcripts) || transcripts.length > MAX_SOURCES) fail(`at most ${MAX_SOURCES} transcripts`);
  if (!Array.isArray(script) || script.length === 0 || script.length > MAX_STATEMENTS) fail(`script requires 1–${MAX_STATEMENTS} statements`);
  if (typeof minScore !== "number" || !(minScore > 0 && minScore <= 1)) fail("minScore must be within (0, 1]");
  const statements = script.map((line, i) => {
    if (typeof line !== "string" || line.length > MAX_STATEMENT_WORDS * MAX_WORD_LENGTH) fail(`script[${i}] must be a bounded string`);
    const tokens = line.split(/\s+/).map(normalizeToken).filter(Boolean);
    if (tokens.length === 0 || tokens.length > MAX_STATEMENT_WORDS) fail(`script[${i}] requires 1–${MAX_STATEMENT_WORDS} words`);
    const counts = new Map<string, number>();
    for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
    return {length: tokens.length, counts};
  });
  const seen = new Set<number>();
  const sources = transcripts.map(transcript => {
    // Re-validate: callers may pass objects that never went through parseTranscript.
    const source = parseTranscript({sourceItemId: transcript?.sourceItemId, timeUnit: "ticks", words: transcript?.words});
    if (seen.has(source.sourceItemId)) fail(`duplicate transcript for source ${source.sourceItemId}`);
    seen.add(source.sourceItemId);
    return source;
  });
  const totalWords = sources.reduce((n, s) => n + s.words.length, 0);
  const scriptWords = statements.reduce((n, s) => n + s.length, 0);
  // ponytail: O(words × script words) scan, capped; index tokens first if real scripts hit the cap.
  if (totalWords * scriptWords > MAX_INDEX_WORK) fail("transcripts × script are too large to index at once");
  const candidates: (Take & {first: number; last: number})[] = [];
  for (const {sourceItemId, words} of sources) {
    const tokens = words.map(w => normalizeToken(w.text));
    statements.forEach((statement, statementIndex) => {
      const span = Math.ceil(statement.length * 1.25);
      for (let first = 0; first < tokens.length; first++) {
        if (!statement.counts.has(tokens[first])) continue;
        const used = new Map<string, number>();
        let matched = 0, best = 0, bestLast = first;
        for (let last = first; last < tokens.length && last - first < span; last++) {
          const t = tokens[last], n = used.get(t) ?? 0;
          if (n < (statement.counts.get(t) ?? 0)) {used.set(t, n + 1); matched++;}
          const score = (2 * matched) / (statement.length + last - first + 1);
          if (score > best) {best = score; bestLast = last;}
        }
        if (best >= minScore) candidates.push({
          sourceItemId, statementIndex, score: best, first, last: bestLast,
          sourceIn: words[first].start, sourceOut: words[bestLast].end, words: words.slice(first, bestLast + 1),
        });
      }
    });
  }
  // ponytail: greedy non-overlap by score, not a global alignment; use DP if takes interleave badly.
  candidates.sort((a, b) => b.score - a.score || a.sourceItemId - b.sourceItemId || a.first - b.first || a.statementIndex - b.statementIndex);
  const occupied = new Map(sources.map(s => [s.sourceItemId, new Uint8Array(s.words.length)]));
  const accepted: typeof candidates = [];
  for (const c of candidates) {
    const used = occupied.get(c.sourceItemId);
    if (!used || used.subarray(c.first, c.last + 1).some(Boolean)) continue;
    used.fill(1, c.first, c.last + 1);
    accepted.push(c);
  }
  accepted.sort((a, b) => a.statementIndex - b.statementIndex || a.sourceItemId - b.sourceItemId || a.sourceIn - b.sourceIn);
  return accepted.map(({first: _f, last: _l, ...take}) => take);
}
