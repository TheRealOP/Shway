// Run: node --test shway/transcribe-local.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { toTranscriptInput } from "./transcribe-local.mjs";
import { parseTranscript } from "./takes.ts";

const S = 254_016_000_000;
const engine = {
  language: "en", source: "whisper-base", speakers: [],
  words: [
    { text: " Welcome", start: 0.1 * S, end: 0.5 * S, confidence: 0.9 },
    { text: "to", start: 0.5 * S, end: 0.6 * S },
    { text: "  ", start: 0.6 * S, end: 0.6 * S },
    { text: "studio.", start: 0.7 * S, end: 1.2 * S, speaker: 0, confidence: 0.5 },
  ],
};

test("engine transcript converts to a TranscriptInput that parseTranscript accepts", () => {
  const input = toTranscriptInput(engine, 41);
  assert.deepEqual(input, {
    sourceItemId: 41, timeUnit: "ticks", language: "en",
    words: [
      { text: "Welcome", start: 0.1 * S, end: 0.5 * S, confidence: 0.9 },
      { text: "to", start: 0.5 * S, end: 0.6 * S },
      { text: "studio.", start: 0.7 * S, end: 1.2 * S, confidence: 0.5 },
    ],
  });
  const parsed = parseTranscript(input, 2 * S);
  assert.equal(parsed.words.length, 3);
  assert.equal(parsed.words[2].end, 1.2 * S);
});

test("hostile engine output is rejected, not guessed", () => {
  const w = (o) => ({ language: "en", words: [{ text: "a", start: 0, end: 10, ...o }] });
  for (const t of [null, {}, { words: "x" }, { words: [] }, { words: [{ text: " ", start: 0, end: 1 }] }, { words: [null] },
    w({ start: -1 }), w({ end: Number.NaN }), w({ start: 1.5 }), w({ start: 20 }), w({ end: 2 ** 60 }), w({ start: "0" }), w({ text: "x".repeat(101) }),
    { words: [{ text: "a", start: 0, end: 10 }, { text: "b", start: 5, end: 12 }] }]) {
    assert.throws(() => toTranscriptInput(t, 1), Error, JSON.stringify(t));
  }
  for (const id of [0, -1, 1.5, Number.NaN, "1", undefined]) assert.throws(() => toTranscriptInput(engine, id));
});

test("odd confidence and language values are dropped, not passed through", () => {
  const out = toTranscriptInput({ language: "<script>", words: [{ text: "a", start: 0, end: 1, confidence: 7 }, { text: "b", start: 1, end: 2, confidence: Number.NaN }] }, 3);
  assert.equal(out.language, undefined);
  assert.deepEqual(out.words, [{ text: "a", start: 0, end: 1 }, { text: "b", start: 1, end: 2 }]);
  assert.equal(parseTranscript(out).words.length, 2);
});
