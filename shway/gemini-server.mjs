// Local Gemini proxy for the Shway surface: the browser calls this on localhost, so the API key
// never reaches a web page. Node ≥ 22, no packages.
//   node shway/gemini-server.mjs [--port 8790]
// Reads GEMINI_API_KEY (and optional GEMINI_MODEL) from the main checkout's .env, shared by every
// worktree, or from the file named by SHWAY_ENV.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_MODEL = "gemini-3.8-flash";
const API = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_BODY = 2 * 1024 * 1024; // ponytail: text-only for now; raise when frames/audio are sent inline
const MAX_PROMPT = 500_000;
const TIMEOUT_MS = 90_000;

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
  for (const k of Object.keys(body)) if (!["prompt", "system", "schema", "model"].includes(k)) throw new HttpError(400, `unsupported field ${k}`);
  const { prompt, system, schema, model = defaultModel } = body;
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > MAX_PROMPT) throw new HttpError(400, "prompt must be a non-empty string");
  if (system !== undefined && (typeof system !== "string" || system.length > MAX_PROMPT)) throw new HttpError(400, "system must be a string");
  if (schema !== undefined && (!schema || typeof schema !== "object" || Array.isArray(schema))) throw new HttpError(400, "schema must be a JSON schema object");
  if (typeof model !== "string" || !/^gemini-[a-z0-9.-]{1,60}$/.test(model)) throw new HttpError(400, "model must be a gemini-* id");
  return {
    model,
    json: schema !== undefined,
    payload: {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      ...(schema ? { generationConfig: { responseMimeType: "application/json", responseSchema: schema } } : {}),
    },
  };
}

/** @param {{key: string, model?: string, fetch?: typeof fetch}} opts */
export function createGeminiServer({ key, model = DEFAULT_MODEL, fetch: doFetch = fetch }) {
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
      if (req.method === "GET" && req.url === "/health") return send(200, { ok: true, model });
      if (req.method !== "POST" || req.url !== "/generate") throw new HttpError(404, "use POST /generate or GET /health");
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "content-type must be application/json");

      let size = 0;
      const chunks = [];
      for await (const c of req) {
        size += c.length;
        if (size > MAX_BODY) throw new HttpError(413, "request body too large");
        chunks.push(c);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HttpError(400, "invalid JSON"); }
      const r = buildRequest(body, model);

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
      return send(status, { error: String(e?.message ?? e).split(key).join("[key]") });
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
  createGeminiServer({ key, model }).listen(port, "127.0.0.1", () => {
    console.log(`Gemini proxy on http://127.0.0.1:${port} (model ${model}, key from ${process.env.GEMINI_API_KEY ? "environment" : file})`);
  });
}
