// Gemini proxy tests against a fake upstream. Run: node --test shway/gemini-server.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnv, allowedOrigin, buildRequest, createGeminiServer } from "./gemini-server.mjs";

const KEY = "test-key-123";

async function serve(reply = { status: 200, body: { candidates: [{ content: { parts: [{ text: "hi" }] } }], usageMetadata: { totalTokenCount: 3 } } }) {
  const seen = [];
  const fake = async (url, init) => {
    seen.push({ url, init, body: JSON.parse(init.body) });
    const r = typeof reply === "function" ? reply() : reply;
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
  const server = createGeminiServer({ key: KEY, fetch: fake });
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
  assert.deepEqual(h.json, { ok: true, model: "gemini-3.8-flash" });
  assert.ok(!JSON.stringify(h.json).includes(KEY));
  await s.close();
});
