// Gemini proxy tests against a fake upstream. Run: node --test shway/gemini-server.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnv, allowedOrigin, buildRequest, createGeminiServer } from "./gemini-server.mjs";

const KEY = "test-key-123";

async function serve(reply = { status: 200, body: { candidates: [{ content: { parts: [{ text: "hi" }] } }], usageMetadata: { totalTokenCount: 3 } } }, opts = {}) {
  const seen = [];
  const fake = async (url, init) => {
    seen.push({ url, init, body: JSON.parse(init.body) });
    const r = typeof reply === "function" ? reply() : reply;
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
  const server = createGeminiServer({ key: KEY, fetch: fake, ...opts });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, { body, headers = {}, method = "POST" } = {}) =>
    fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, headers: r.headers, json: await r.json().catch(() => null) }));
  return { call, seen, close: () => new Promise((r) => server.close(r)) };
}

test("parseEnv handles quotes, comments, export and spaces", () => {
  assert.deepEqual(parseEnv('# c\nGEMINI_API_KEY=abc\nexport A = "q v"\nB=\'x\'\n\nbad line\nC='), { GEMINI_API_KEY: "abc", A: "q v", B: "x", C: "" });
});

test("only local origins may use the proxy", () => {
  for (const o of [undefined, "http://localhost:8772", "http://127.0.0.1:8771", "http://[::1]:3000"]) assert.ok(allowedOrigin(o), String(o));
  for (const o of ["https://evil.example", "http://localhost.evil.com", "null", "file://", "garbage"]) assert.ok(!allowedOrigin(o), o);
});

test("buildRequest rejects hostile bodies", () => {
  for (const b of [null, [], "x", {}, { prompt: "" }, { prompt: "  " }, { prompt: 5 }, { prompt: "x".repeat(500_001) },
    { prompt: "a", extra: 1 }, { prompt: "a", schema: [] }, { prompt: "a", schema: "s" }, { prompt: "a", system: 3 },
    { prompt: "a", model: "gpt-4" }, { prompt: "a", model: "gemini-../../x" }]) {
    assert.throws(() => buildRequest(b), JSON.stringify(b)?.slice(0, 40));
  }
});

test("text request is forwarded with the key in a header, not the URL", async () => {
  const s = await serve();
  const r = await s.call("/generate", { body: { prompt: "hello", system: "be brief" } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { model: "gemini-3.8-flash", usage: { totalTokenCount: 3 }, text: "hi" });
  const [{ url, init, body }] = s.seen;
  assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
  assert.ok(!url.includes(KEY));
  assert.equal(init.headers["x-goog-api-key"], KEY);
  assert.deepEqual(body.systemInstruction, { parts: [{ text: "be brief" }] });
  assert.equal(body.generationConfig, undefined);
  await s.close();
});

test("schema requests ask for JSON and return parsed JSON", async () => {
  const s = await serve({ status: 200, body: { candidates: [{ content: { parts: [{ text: '{"take":2}' }] } }] } });
  const schema = { type: "OBJECT", properties: { take: { type: "INTEGER" } } };
  const r = await s.call("/generate", { body: { prompt: "pick", schema } });
  assert.deepEqual(r.json.json, { take: 2 });
  assert.deepEqual(s.seen[0].body.generationConfig, { responseMimeType: "application/json", responseSchema: schema });
  await s.close();
});

test("upstream failures become clear errors that never contain the key", async () => {
  const s = await serve({ status: 400, body: { error: { message: `API key ${KEY} not valid` } } });
  const r = await s.call("/generate", { body: { prompt: "x" } });
  assert.equal(r.status, 502);
  assert.ok(!JSON.stringify(r.json).includes(KEY));
  assert.match(r.json.error, /Gemini 400: API key \[key\] not valid/);
  await s.close();
});

test("blocked, empty and non-JSON answers are reported", async () => {
  let s = await serve({ status: 200, body: { candidates: [{ finishReason: "SAFETY", content: { parts: [] } }] } });
  assert.match((await s.call("/generate", { body: { prompt: "x" } })).json.error, /no text \(SAFETY\)/);
  await s.close();
  s = await serve({ status: 200, body: { candidates: [{ content: { parts: [{ text: "not json" }] } }] } });
  const r = await s.call("/generate", { body: { prompt: "x", schema: { type: "OBJECT" } } });
  assert.equal(r.status, 502);
  await s.close();
});

test("foreign origins, wrong methods, content types and oversized bodies are refused before calling Gemini", async () => {
  const s = await serve();
  assert.equal((await s.call("/generate", { body: { prompt: "x" }, headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await s.call("/nope", { body: { prompt: "x" } })).status, 404);
  assert.equal((await s.call("/generate", { body: { prompt: "x" }, headers: { "content-type": "text/plain" } })).status, 415);
  assert.equal((await s.call("/generate", { body: "{not json" })).status, 400);
  assert.equal((await s.call("/generate", { body: { prompt: "x".repeat(3 * 1024 * 1024) } })).status, 413);
  assert.equal(s.seen.length, 0);
  await s.close();
});

test("local pages get CORS headers; health reports the model, not the key", async () => {
  const s = await serve();
  const pre = await s.call("/generate", { method: "OPTIONS", headers: { origin: "http://localhost:8772" } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "http://localhost:8772");
  const h = await s.call("/health", { method: "GET", headers: { origin: "http://localhost:8772" } });
  assert.deepEqual(h.json, { ok: true, model: "gemini-3.8-flash", jev: false });
  assert.ok(!JSON.stringify(h.json).includes(KEY));
  await s.close();
});

test("transcribe forwards inline audio with a verbatim instruction and returns text", async () => {
  const s = await serve({ status: 200, body: { candidates: [{ content: { parts: [{ text: "use the take where I laugh" }] } }] } });
  const data = Buffer.from("RIFF fake wav").toString("base64");
  const r = await s.call("/transcribe", { body: { mimeType: "audio/webm;codecs=opus", data }, headers: { origin: "http://127.0.0.1:8771" } });
  assert.equal(r.status, 200);
  assert.equal(r.json.text, "use the take where I laugh");
  const [{ url, body }] = s.seen;
  assert.match(url, /gemini-3\.8-flash:generateContent$/);
  assert.deepEqual(body.contents[0].parts[0], { inlineData: { mimeType: "audio/webm", data } });
  assert.match(body.contents[0].parts[1].text, /verbatim/);
  assert.equal(body.generationConfig, undefined);
  await s.close();
});

test("transcribe rejects bad audio requests before calling Gemini; only it gets the larger cap", async () => {
  const s = await serve();
  for (const body of [{}, { mimeType: "video/mp4", data: "AAAA" }, { mimeType: "audio/wav" }, { mimeType: "audio/wav", data: "" },
    { mimeType: "audio/wav", data: "not base64!" }, { mimeType: "audio/wav", data: "AAAA", prompt: "x" }, { mimeType: 5, data: "AAAA" }]) {
    assert.equal((await s.call("/transcribe", { body })).status, 400, JSON.stringify(body));
  }
  const big = "A".repeat(5 * 1024 * 1024);
  assert.equal((await s.call("/generate", { body: { prompt: big } })).status, 413);
  assert.equal((await s.call("/transcribe", { body: { mimeType: "audio/wav", data: "A".repeat(11 * 1024 * 1024) } })).status, 413);
  assert.equal((await s.call("/transcribe", { body: { mimeType: "audio/wav", data: big } })).status, 200);
  assert.equal((await s.call("/transcribe", { body: { mimeType: "audio/wav", data: "AAAA" }, headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal(s.seen.length, 1);
  await s.close();
});

const JEV = "jev-secret-456";
const QUESTION = { take: { type: "choice", instructions: "Pick.", criteria: { "take-1": "a", "no-change": "none" } } };
test("decide forwards a bounded Jev question with a bearer key and returns its answers", async () => {
  const s = await serve({ status: 200, body: { model: "jev-1.13.0", answers: { take: { type: "choice", choice: "take-1", confidence: 0.9, probabilities: {} } }, usage: { input_tokens: 1 } } }, { jevKey: JEV });
  const r = await s.call("/decide", { body: { state: { correction: "x" }, questions: QUESTION } });
  assert.equal(r.status, 200);
  assert.equal(r.json.answers.take.choice, "take-1");
  assert.equal(s.seen[0].url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(s.seen[0].init.headers.authorization, `Bearer ${JEV}`);
  assert.deepEqual(s.seen[0].body, { model: "jev-1.13.0", state: { correction: "x" }, questions: QUESTION });
  for (const bad of [{ questions: QUESTION }, { state: 1, questions: {} }, { state: 1, questions: { q: { type: "free" } } },
    { state: 1, questions: QUESTION, model: "gpt-5" }, { state: 1, questions: QUESTION, extra: 1 }]) {
    assert.equal((await s.call("/decide", { body: bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal(s.seen.length, 1);
  assert.equal((await s.call("/health", { method: "GET" })).json.jev, true);
  await s.close();
});

test("decide is off without a key, and upstream errors never contain it", async () => {
  const off = await serve();
  assert.equal((await off.call("/decide", { body: { state: 1, questions: QUESTION } })).status, 503);
  assert.equal(off.seen.length, 0);
  await off.close();
  const s = await serve({ status: 401, body: { detail: `bad token ${JEV}` } }, { jevKey: JEV });
  const r = await s.call("/decide", { body: { state: 1, questions: QUESTION } });
  assert.equal(r.status, 502);
  assert.ok(!JSON.stringify(r.json).includes(JEV), r.json.error);
  await s.close();
});
