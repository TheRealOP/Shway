// Local Gemini proxy for the Shway surface: the browser calls this on localhost, so the API key
// never reaches a web page. Node ≥ 22, no packages.
//   node shway/gemini-server.mjs [--port 8790]
// POST /generate takes {prompt, system?, schema?, model?, images?: [{mimeType: image/png|image/jpeg, data}]} (one image).
// Reads GEMINI_API_KEY (and optional GEMINI_MODEL, JEV_KEY) from the main checkout's .env, shared by
// every worktree, or from the file named by SHWAY_ENV. With JEV_KEY, POST /decide forwards TypeSafe Jev
// questions (https://api.typesafe.ai/redoc, POST /v1/systemone) with the key kept here.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_MODEL = "gemini-3.8-flash";
const API = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_BODY = 2 * 1024 * 1024;
const MAX_AUDIO_BODY = 10 * 1024 * 1024; // /transcribe only: base64 audio of a ≤15 s push-to-talk
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // one Program monitor PNG at Retina size
const MAX_IMAGE_BODY = 9 * 1024 * 1024; // /generate: that image in base64 plus the prompt
const IMAGE_TYPES = ["image/png", "image/jpeg"];
const AUDIO_TYPES = ["audio/webm", "audio/ogg", "audio/mp4", "audio/wav"];
const TRANSCRIBE = "Transcribe this audio verbatim. Return only the spoken words, no commentary, labels or timestamps.";
const MAX_PROMPT = 500_000;
const TIMEOUT_MS = 90_000;
const JEV_API = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_JEV_MODEL = "jev-1.13.0"; // pinned: jev-latest moves; GET /v1/models lists aliases
const JEV_TIMEOUT_MS = 10_000;

/** KEY=VALUE lines; comments, blank lines and `export ` prefixes allowed; one pair of quotes stripped. */
export function parseEnv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    if (line.trimStart().startsWith("#")) continue;
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** The .env beside the main checkout, so all worktrees share one key file. */
export function envPath() {
  if (process.env.SHWAY_ENV) return process.env.SHWAY_ENV;
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
  return resolve(dirname(common), ".env");
}

/** Only pages served from this machine may spend the key (a visited website must not). */
export function allowedOrigin(origin) {
  if (origin === undefined) return true; // curl / local tools
  try {
    const u = new URL(origin);
    return (u.protocol === "http:" || u.protocol === "https:") && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** Validate a /generate request and build the Gemini generateContent body. */
export function buildRequest(body, defaultModel = DEFAULT_MODEL) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be a JSON object");
  for (const k of Object.keys(body)) if (!["prompt", "system", "schema", "model", "images"].includes(k)) throw new HttpError(400, `unsupported field ${k}`);
  const { prompt, system, schema, model = defaultModel, images = [] } = body;
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > MAX_PROMPT) throw new HttpError(400, "prompt must be a non-empty string");
  if (system !== undefined && (typeof system !== "string" || system.length > MAX_PROMPT)) throw new HttpError(400, "system must be a string");
  if (schema !== undefined && (!schema || typeof schema !== "object" || Array.isArray(schema))) throw new HttpError(400, "schema must be a JSON schema object");
  if (typeof model !== "string" || !/^gemini-[a-z0-9.-]{1,60}$/.test(model)) throw new HttpError(400, "model must be a gemini-* id");
  if (!Array.isArray(images) || images.length > 1) throw new HttpError(400, "images must be an array of at most 1 image");
  for (const i of images) {
    if (!i || typeof i !== "object" || Object.keys(i).some((k) => !["mimeType", "data"].includes(k))) throw new HttpError(400, "an image is {mimeType, data}");
    if (!IMAGE_TYPES.includes(i.mimeType)) throw new HttpError(400, `image mimeType must be one of ${IMAGE_TYPES.join(", ")}`);
    if (typeof i.data !== "string" || !i.data || !/^[A-Za-z0-9+/]+={0,2}$/.test(i.data)) throw new HttpError(400, "image data must be non-empty base64");
    if (Math.floor((i.data.length * 3) / 4) > MAX_IMAGE_BYTES) throw new HttpError(413, "image too large");
  }
  return {
    model,
    json: schema !== undefined,
    payload: {
      contents: [{ role: "user", parts: [...images.map((i) => ({ inlineData: { mimeType: i.mimeType, data: i.data } })), { text: prompt }] }],
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      ...(schema ? { generationConfig: { responseMimeType: "application/json", responseSchema: schema } } : {}),
    },
  };
}

/** Validate a /transcribe request ({mimeType, data: base64}) and build the generateContent body. */
export function buildTranscribeRequest(body, model = DEFAULT_MODEL) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be a JSON object");
  for (const k of Object.keys(body)) if (!["mimeType", "data"].includes(k)) throw new HttpError(400, `unsupported field ${k}`);
  const { mimeType, data } = body;
  // MediaRecorder reports e.g. "audio/webm;codecs=opus": accept parameters on an allowed base type.
  if (typeof mimeType !== "string" || !AUDIO_TYPES.includes(mimeType.split(";")[0].trim().toLowerCase())) throw new HttpError(400, `mimeType must be one of ${AUDIO_TYPES.join(", ")}`);
  if (typeof data !== "string" || !data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new HttpError(400, "data must be non-empty base64");
  return {
    model,
    json: false,
    payload: { contents: [{ role: "user", parts: [{ inlineData: { mimeType: mimeType.split(";")[0].trim().toLowerCase(), data } }, { text: TRANSCRIBE }] }] },
  };
}

/** Validate a /decide request ({state, questions, model?}): the TypeSafe systemone body, bounded. */
export function buildDecideRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be a JSON object");
  for (const k of Object.keys(body)) if (!["state", "questions", "model"].includes(k)) throw new HttpError(400, `unsupported field ${k}`);
  const { state, questions, model = DEFAULT_JEV_MODEL } = body;
  if (state === undefined || state === null) throw new HttpError(400, "state is required");
  const names = questions && typeof questions === "object" && !Array.isArray(questions) ? Object.keys(questions) : [];
  if (names.length < 1 || names.length > 8) throw new HttpError(400, "questions must be an object with 1–8 named questions");
  for (const n of names) if (!["choice", "noul", "score"].includes(questions[n]?.type)) throw new HttpError(400, `question ${n} needs type choice, noul or score`);
  if (typeof model !== "string" || !/^jev-[a-z0-9.-]{1,40}$/.test(model)) throw new HttpError(400, "model must be a jev-* name");
  return { model, state, questions };
}

/** @param {{key: string, model?: string, jevKey?: string, fetch?: typeof fetch}} opts */
export function createGeminiServer({ key, model = DEFAULT_MODEL, jevKey = "", fetch: doFetch = fetch }) {
  if (!key) throw new Error("GEMINI_API_KEY is empty");
  return createServer(async (req, res) => {
    const origin = req.headers.origin;
    const send = (status, value) => {
      res.writeHead(status, {
        "content-type": "application/json",
        ...(origin && allowedOrigin(origin) ? { "access-control-allow-origin": origin, vary: "origin" } : {}),
      });
      res.end(JSON.stringify(value));
    };
    try {
      if (!allowedOrigin(origin)) throw new HttpError(403, "origin not allowed");
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": origin ?? "*", "access-control-allow-methods": "POST, GET",
          "access-control-allow-headers": "content-type", vary: "origin",
        });
        return res.end();
      }
      if (req.method === "GET" && req.url === "/health") return send(200, { ok: true, model, jev: Boolean(jevKey) });
      const route = req.method === "POST" && ["/generate", "/transcribe", "/decide"].includes(req.url) ? req.url : null;
      if (!route) throw new HttpError(404, "use POST /generate, /transcribe, /decide or GET /health");
      if (route === "/decide" && !jevKey) throw new HttpError(503, "JEV_KEY is not configured");
      const limit = route === "/transcribe" ? MAX_AUDIO_BODY : route === "/generate" ? MAX_IMAGE_BODY : MAX_BODY;
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "content-type must be application/json");

      let size = 0;
      const chunks = [];
      for await (const c of req) {
        size += c.length;
        // Keep reading (and discarding) a modestly oversized upload so the client sees the 413
        // instead of a broken pipe; cut off anything far larger.
        if (size > 4 * limit) return req.destroy();
        if (size <= limit) chunks.push(c);
      }
      if (size > limit) throw new HttpError(413, "request body too large");
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HttpError(400, "invalid JSON"); }
      if (route === "/decide") {
        const d = buildDecideRequest(body);
        const upstream = await doFetch(JEV_API, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${jevKey}` },
          body: JSON.stringify(d),
          signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
        });
        const data = await upstream.json().catch(() => null);
        if (!upstream.ok) throw new HttpError(502, `Jev ${upstream.status}: ${JSON.stringify(data?.detail ?? data?.error ?? "request failed").slice(0, 300)}`);
        if (!data?.answers || typeof data.answers !== "object") throw new HttpError(502, "Jev returned no answers");
        return send(200, { model: data.model, answers: data.answers, usage: data.usage ?? null });
      }
      const r = route === "/transcribe" ? buildTranscribeRequest(body, model) : buildRequest(body, model);

      const upstream = await doFetch(`${API}/${r.model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(r.payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const data = await upstream.json().catch(() => null);
      if (!upstream.ok) throw new HttpError(502, `Gemini ${upstream.status}: ${data?.error?.message ?? "request failed"}`);
      const candidate = data?.candidates?.[0];
      const text = (candidate?.content?.parts ?? []).map((p) => p?.text ?? "").join("");
      if (!text) throw new HttpError(502, `Gemini returned no text (${candidate?.finishReason ?? data?.promptFeedback?.blockReason ?? "unknown"})`);
      const out = { model: r.model, usage: data.usageMetadata ?? null };
      if (!r.json) return send(200, { ...out, text });
      try { return send(200, { ...out, json: JSON.parse(text) }); } catch { throw new HttpError(502, "Gemini returned invalid JSON for the schema"); }
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e?.name === "TimeoutError" ? 504 : 500;
      // Never echo the key, even if an upstream error message contains it.
      let message = String(e?.message ?? e).split(key).join("[key]");
      if (jevKey) message = message.split(jevKey).join("[key]");
      return send(status, { error: message });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--port");
  const port = Number(i > 0 ? process.argv[i + 1] : 8790);
  const file = envPath();
  let env = {};
  try { env = parseEnv(readFileSync(file, "utf8")); } catch { /* reported below */ }
  const key = process.env.GEMINI_API_KEY || env.GEMINI_API_KEY;
  if (!key) {
    console.error(`No GEMINI_API_KEY in ${file} or the environment.`);
    process.exit(1);
  }
  const model = process.env.GEMINI_MODEL || env.GEMINI_MODEL || DEFAULT_MODEL;
  const jevKey = process.env.JEV_KEY || env.JEV_KEY || "";
  createGeminiServer({ key, model, jevKey }).listen(port, "127.0.0.1", () => {
    console.log(`Gemini proxy on http://127.0.0.1:${port} (model ${model}, key from ${process.env.GEMINI_API_KEY ? "environment" : file}; Jev ${jevKey ? "on" : "off"})`);
  });
}
