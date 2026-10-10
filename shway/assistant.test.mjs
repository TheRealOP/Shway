// node --test shway/assistant.test.mjs — fake editor (JSON-lines TCP) and fake Gemini proxy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as tcp } from "node:net";
import { createServer as http } from "node:http";
import { createAssistant, validateAction } from "./assistant.mjs";

const TPS = 254016000000, F = TPS / 30;
const REQUIRED = ["project.inspect", "sequence.inspect", "timeline.select", "playhead.set", "edit.undo", "file.exportMedia", "jobs.list",
  "proposal.preview", "proposal.inspect", "proposal.cancel", "proposal.commit", "proposal.render", "transcript.inspect"];

const clip = (clip, item, link, start, dur, sourceIn, name) => ({ clip, item, link, name, start: start * F, duration: dur * F, sourceIn: sourceIn * F, sourceOut: (sourceIn + dur) * F });

function fakeEditor() {
  const st = { revision: 5, proposal: null, next: 1, history: [], previews: [], onPreview: null };
  const seq = () => ({
    id: 27, name: "Cut", duration: 450 * F, settings: { frame_rate: { num: 30, den: 1 } }, playhead: 0, selection: [],
    video: [{ id: 1, locked: false, items: [clip(10, 1, 1, 0, 300, 30, "C5500.MP4"), clip(12, 2, 2, 300, 150, 0, "C5517.MP4")] }],
    audio: [{ id: 2, locked: false, items: [clip(11, 1, 1, 0, 300, 30, "C5500.MP4"), clip(13, 2, 2, 300, 150, 0, "C5517.MP4")] }],
  });
  const exec = (command, p) => {
    switch (command) {
      case "project.inspect": return { revision: st.revision, activeSequence: 27, root: { children: [{ item: 1, type: "Movie", duration: 1000 * F }, { item: 2, type: "Movie", duration: 150 * F }] } };
      case "sequence.inspect": return seq();
      case "transcript.inspect": return { words: [{ text: "hello", clip: 10 }, { text: "we're", clip: 13 }, { text: "at", clip: 13 }, { text: "Chili's", clip: 13 }] }; // words land on the audio half
      case "proposal.preview": {
        st.onPreview?.();
        if (st.proposal) throw new Error("edit proposal: cancel or commit the current preview before proposing another");
        if (p.expectedRevision !== st.revision) throw new Error("edit proposal: stale revision, different active sequence or active dynamic trim");
        st.previews.push(p);
        st.proposal = { token: st.next++, label: p.label, revision: st.revision };
        return { token: st.proposal.token, expectedRevision: p.expectedRevision, label: p.label, sequence: seq(), results: [{}] };
      }
      case "proposal.cancel":
        if (st.proposal?.token !== p.token) throw new Error("edit proposal: unknown or expired preview token");
        st.proposal = null; return { cancelled: true };
      case "proposal.commit": {
        if (st.proposal?.token !== p.token) throw new Error("edit proposal: unknown or expired preview token");
        if (st.proposal.revision !== st.revision) throw new Error("edit proposal: stale project or interaction context; preview again");
        st.history.push(st.proposal.label); st.revision++; const label = st.proposal.label; st.proposal = null;
        return { committed: true, revision: st.revision, label };
      }
    }
    throw new Error(`unknown command ${command}`);
  };
  const server = tcp((sock) => {
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const req = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        let reply;
        try {
          const result = req.method === "engine.commands" ? REQUIRED.map((id) => ({ id })) : exec(req.params.command, req.params.params);
          reply = { id: req.id, ok: true, result };
        } catch (e) { reply = { id: req.id, ok: false, error: e.message }; }
        sock.write(JSON.stringify(reply) + "\n");
      }
    });
  });
  return { st, server };
}

function fakeProxy() {
  const answers = [], prompts = [];
  let gate = null;
  const server = http(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    if (req.url === "/health") { res.writeHead(200); return res.end(JSON.stringify({ ok: true, jev: false })); }
    prompts.push(JSON.parse(body));
    if (gate) await gate;
    const a = answers.shift();
    if (typeof a === "function") a();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ json: A(typeof a === "function" ? answers.shift() : a) }));
  });
  return { answers, prompts, server, hold() { let open; gate = new Promise((r) => (open = r)); return () => { gate = null; open(); }; } };
}

// Model answers in the nested schema shape: ({action, reply, ...fields}) -> {action, reply, [action]: fields}.
const A = ({ action, reply, ...f }) => (action === "answer" ? { action, reply } : { action, reply, [action]: f });
const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));

async function setup(opts = {}) {
  const editor = fakeEditor(), proxy = fakeProxy();
  const ep = await listen(editor.server), pp = await listen(proxy.server);
  const app = createAssistant({ editor: `127.0.0.1:${ep}`, proxy: `http://127.0.0.1:${pp}`, ...opts });
  const port = await listen(app);
  const call = async (path, body, headers = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, body === undefined ? { headers } : { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const close = () => { for (const s of [editor.server, proxy.server, app]) { s.closeAllConnections?.(); s.close(); } };
  return { editor: editor.st, proxy, call, close };
}

test("answer: state keeps the conversation; the model sees project data incl. transcript text", async (t) => {
  const s = await setup(); t.after(s.close);
  s.proxy.answers.push({ action: "answer", reply: "The second clip is at Chili's." });
  const r = await s.call("/chat", { message: "where is the Chili's part?" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { reply: "The second clip is at Chili's.", pending: null, busy: false });
  const st = await s.call("/chat/state");
  assert.deepEqual(st.body, { messages: [{ role: "user", text: "where is the Chili's part?" }, { role: "assistant", text: "The second clip is at Chili's." }], pending: null, busy: false });
  const prompt = s.proxy.prompts[0].prompt;
  assert.match(prompt, /"id":12,"track":"V1","file":"C5517.MP4","start":10,"duration":5,"link":2,"says":"we're at Chili's"/);
  assert.doesNotMatch(prompt, /"id":11/); // linked audio is folded into its video clip
  assert.ok(s.proxy.prompts[0].schema && s.proxy.prompts[0].system);
});

test("trim: previews exact ripple trim, accept commits one step, reject cancels", async (t) => {
  const s = await setup(); t.after(s.close);
  s.proxy.answers.push({ action: "trim", reply: "Trimming 1 s off the end of the first clip.", clip: 10, edge: "out", direction: "shorten", amount: 1, unit: "seconds" });
  let r = await s.call("/chat", { message: "trim the end of the first clip by 1 second" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.pending, { token: 1, label: "Trim end of C5500.MP4 (shorten 30 frames)" });
  assert.deepEqual(s.editor.previews[0], { expectedRevision: 5, sequence: 27, label: "Trim end of C5500.MP4 (shorten 30 frames)",
    steps: [{ command: "timeline.trim", params: { clip: 10, source: 1, edge: "out", mode: "ripple", deltaFrames: -30 } }] });
  assert.equal(s.editor.history.length, 0);
  r = await s.call("/chat/accept", {});
  assert.equal(r.status, 200);
  assert.equal(r.body.pending, null);
  assert.deepEqual(s.editor.history, ["Trim end of C5500.MP4 (shorten 30 frames)"]);
  assert.equal((await s.call("/chat/accept", {})).status, 409); // nothing pending

  s.proxy.answers.push({ action: "trim", reply: "Extending the start.", clip: 12, edge: "in", direction: "shorten", amount: 10, unit: "frames" });
  r = await s.call("/chat", { message: "tighten the start of the Chili's clip by 10 frames" });
  assert.equal(r.body.pending.token, 2);
  assert.equal(s.editor.previews[1].steps[0].params.deltaFrames, 10);
  r = await s.call("/chat/reject", "");
  assert.equal(r.status, 200);
  assert.equal(s.editor.proposal, null);
  assert.equal(s.editor.history.length, 1);
});

test("a newer message cancels the older pending preview first", async (t) => {
  const s = await setup(); t.after(s.close);
  s.proxy.answers.push({ action: "trim", reply: "ok", clip: 10, edge: "out", direction: "shorten", amount: 5, unit: "frames" });
  await s.call("/chat", { message: "trim it" });
  assert.equal(s.editor.proposal.token, 1);
  s.proxy.answers.push({ action: "trim", reply: "ok", clip: 10, edge: "out", direction: "shorten", amount: 6, unit: "frames" });
  const r = await s.call("/chat", { message: "actually 6 frames" });
  assert.equal(r.body.pending.token, 2);
  assert.equal(s.editor.previews.length, 2);
});

test("remove and move are validated, then refused: the proposal boundary has no delete or move step", async (t) => {
  const s = await setup(); t.after(s.close);
  s.proxy.answers.push({ action: "remove", reply: "Removing the Chili's clip.", clips: [12] });
  let r = await s.call("/chat", { message: "remove the Chili's part" });
  assert.match(r.body.reply, /remove C5517\.MP4.*isn't supported.*Nothing changed/);
  assert.equal(r.body.pending, null);
  s.proxy.answers.push({ action: "move", reply: "Moving.", clip: 12, target: 10, position: "before" });
  r = await s.call("/chat", { message: "put the Chili's part first" });
  assert.match(r.body.reply, /move C5517\.MP4 before C5500\.MP4.*isn't supported/);
  assert.equal(s.editor.previews.length, 0);
});

test("invalid model output gets one retry quoting the error, then a polite refusal", async (t) => {
  const s = await setup(); t.after(s.close);
  s.proxy.answers.push({ action: "remove", reply: "x", clips: [99] }, { action: "remove", reply: "Removing.", clips: [12] });
  let r = await s.call("/chat", { message: "remove the Chili's part" });
  assert.match(s.proxy.prompts[1].prompt, /clip 99 is not a clip in the active sequence/);
  assert.match(r.body.reply, /isn't supported/);
  s.proxy.answers.push({ action: "delete_everything", reply: "x" }, { action: "trim", reply: "x", clip: 10, edge: "out", direction: "shorten", amount: 9999, unit: "frames" });
  r = await s.call("/chat", { message: "trim a lot" });
  assert.match(r.body.reply, /^Sorry, I couldn't.*only 300 frames long.*Nothing changed\.$/);
  assert.equal(s.editor.previews.length, 0);
});

test("stale revision: at preview and at accept, nothing changes and the creator is asked to retry", async (t) => {
  const s = await setup(); t.after(s.close);
  s.proxy.answers.push(() => { s.editor.revision++; }, { action: "trim", reply: "ok", clip: 10, edge: "out", direction: "shorten", amount: 5, unit: "frames" });
  let r = await s.call("/chat", { message: "trim it" });
  assert.match(r.body.reply, /project changed.*send it again/);
  assert.equal(r.body.pending, null);
  s.proxy.answers.push({ action: "trim", reply: "ok", clip: 10, edge: "out", direction: "shorten", amount: 5, unit: "frames" });
  r = await s.call("/chat", { message: "trim it" });
  assert.ok(r.body.pending);
  s.editor.revision++; // the creator edited in the app meanwhile
  r = await s.call("/chat/accept", {});
  assert.equal(r.status, 200);
  assert.match(r.body.reply, /changed since that preview/);
  assert.equal(r.body.pending, null);
  assert.equal(s.editor.proposal, null);
  assert.equal(s.editor.history.length, 0);
});

test("replace_take without a take index says so", async (t) => {
  const s = await setup(); t.after(s.close);
  s.proxy.answers.push({ action: "replace_take", reply: "Swapping.", correction: "use the take where I laugh" });
  const r = await s.call("/chat", { message: "use the take where I laugh" });
  assert.match(r.body.reply, /no take index/);
});

test("one request at a time: 409 while busy", async (t) => {
  const s = await setup(); t.after(s.close);
  const release = s.proxy.hold();
  s.proxy.answers.push({ action: "answer", reply: "done" });
  const first = s.call("/chat", { message: "slow one" });
  while (!s.proxy.prompts.length) await new Promise((r) => setTimeout(r, 5));
  assert.equal((await s.call("/chat/state")).body.busy, true);
  const second = await s.call("/chat", { message: "again" });
  assert.equal(second.status, 409);
  assert.match(second.body.error, /busy/);
  assert.equal((await s.call("/chat/reject", "")).status, 409);
  release();
  assert.equal((await first).status, 200);
});

test("HTTP boundary: origin, malformed JSON, fields, size, routes, editor down", async (t) => {
  const s = await setup(); t.after(s.close);
  assert.equal((await s.call("/chat/state", undefined, { origin: "https://evil.example" })).status, 403);
  assert.equal((await s.call("/chat", { message: "hi" }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await s.call("/chat", "{nope")).status, 400);
  assert.equal((await s.call("/chat", [1])).status, 400);
  assert.equal((await s.call("/chat", { message: "" })).status, 400);
  assert.equal((await s.call("/chat", { message: "x".repeat(2001) })).status, 400);
  assert.equal((await s.call("/chat", { message: "hi", extra: 1 })).status, 400);
  assert.equal((await s.call("/chat/accept", { token: 1 })).status, 400);
  assert.equal((await s.call("/chat", { message: "x".repeat(70_000) })).status, 413);
  assert.equal((await s.call("/nope", {})).status, 404);
  assert.deepEqual((await s.call("/chat/state")).body.messages, []);
  const down = createAssistant({ editor: "127.0.0.1:1", proxy: "http://127.0.0.1:1" });
  const port = await listen(down);
  t.after(() => down.close());
  const r = await fetch(`http://127.0.0.1:${port}/chat`, { method: "POST", body: JSON.stringify({ message: "hi" }) });
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /editor 127\.0\.0\.1:1/);
});

test("validateAction: extra fields, missing fields, ids, handles", () => {
  const c = (id, item, sourceIn, dur) => ({ clip: id, item, name: `c${id}`, start: 0, duration: dur * F, sourceIn: sourceIn * F, sourceOut: (sourceIn + dur) * F });
  const snap = { clips: new Map([[10, c(10, 1, 30, 300)], [12, c(12, 2, 0, 150)]]), frame: F, rate: { num: 30, den: 1 },
    project: { root: { children: [{ item: 1, duration: 1000 * F }, { item: 2, duration: 150 * F }] } } };
  const bad = (a, re, raw = false) => assert.throws(() => validateAction(raw ? a : A(a), snap), re);
  const trim = (o) => ({ action: "trim", reply: "r", clip: 10, edge: "out", direction: "shorten", amount: 1, unit: "frames", ...o });
  bad({ action: "answer", reply: "r", remove: { clips: [10] } }, /field remove is not allowed/, true);
  bad({ action: "trim", reply: "r", clip: 10, trim: {} }, /field clip is not allowed/, true);
  bad({ action: "trim", reply: "r", trim: { clip: 10, edge: "out", direction: "shorten", amount: 1, unit: "frames" }, move: { clip: 10 } }, /field move is not allowed/, true);
  bad({ action: "trim", reply: "r" }, /needs a trim object/, true);
  bad({ action: "trim", reply: "r", clip: 10 }, /needs trim.edge/);
  bad(trim({ frames: 3 }), /field trim.frames is not allowed/);
  bad({ action: "answer" }, /reply/);
  bad({ action: "shell", reply: "r" }, /action must be/);
  bad({ action: "remove", reply: "r", clips: [] }, /1–32/);
  bad({ action: "remove", reply: "r", clips: [10, 10] }, /distinct/);
  bad({ action: "remove", reply: "r", clips: ["10"] }, /not a clip/);
  bad({ action: "move", reply: "r", clip: 10, target: 10, position: "after" }, /different clip/);
  bad(trim({ amount: 1.5 }), /whole number/);
  bad(trim({ amount: -2 }), /positive/);
  bad(trim({ amount: 0.01, unit: "seconds" }), /less than one frame/);
  bad(trim({ amount: 300 }), /only 300 frames long/);
  bad(trim({ edge: "in", direction: "extend", amount: 31 }), /only 30 frames of media before/);
  bad(trim({ clip: 12, direction: "extend" }), /only 0 frames of media after/);
  assert.equal(validateAction(A(trim({ edge: "in", direction: "extend", amount: 30 })), snap).deltaFrames, -30);
  assert.equal(validateAction(A(trim({ direction: "extend", amount: 2, unit: "seconds" })), snap).deltaFrames, 60);
  assert.deepEqual(validateAction({ action: "answer", reply: " hi ", trim: null }, snap), { action: "answer", reply: "hi" });
});
