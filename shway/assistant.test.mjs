// node --test shway/assistant.test.mjs — fake editor (JSON-lines TCP) and fake Gemini proxy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as tcp } from "node:net";
import { createServer as http } from "node:http";
import { existsSync, writeFileSync } from "node:fs";
import { createAssistant, fit, readInk, validateAction, SKETCH_MODEL } from "./assistant.mjs";
import { MAX_IMAGE_BYTES } from "./gemini-server.mjs";

const TPS = 254016000000, F = TPS / 30;
const REQUIRED = ["project.inspect", "sequence.inspect", "timeline.select", "playhead.set", "edit.undo", "file.exportMedia", "jobs.list",
  "proposal.preview", "proposal.inspect", "proposal.cancel", "proposal.commit", "proposal.render", "transcript.inspect",
  "playhead.step", "playhead.nextEdit", "playhead.prevEdit"];

const clip = (clip, item, link, start, dur, sourceIn, name) => ({ clip, item, link, name, start: start * F, duration: dur * F, sourceIn: sourceIn * F, sourceOut: (sourceIn + dur) * F });

function fakeEditor() {
  const st = { revision: 5, proposal: null, next: 1, history: [], previews: [], renders: [], onPreview: null, playhead: 400 * F, playing: true, ui: [], ink: [], inkGate: null, shots: [], shotSize: 64, monitorFrame: null, monitorRevision: null };
  const seq = () => ({
    id: 27, name: "Cut", duration: 450 * F, settings: { frame_rate: { num: 30, den: 1 } }, playhead: 0, selection: [],
    video: [{ id: 1, locked: false, items: [clip(10, 1, 1, 0, 300, 30, "C5500.MP4"), clip(12, 2, 2, 300, 150, 0, "C5517.MP4")] }],
    audio: [{ id: 2, locked: false, items: [clip(11, 1, 1, 0, 300, 30, "C5500.MP4"), clip(13, 2, 2, 300, 150, 0, "C5517.MP4")] }],
  });
  const exec = (command, p) => {
    switch (command) {
      case "project.inspect": return { revision: st.revision, activeSequence: 27, root: { children: [{ item: 1, type: "Movie", duration: 1000 * F }, { item: 2, type: "Movie", duration: 150 * F }] } };
      case "sequence.inspect": return seq();
      case "playhead.set": st.ui.push(["seek", p.time]); st.playhead = p.time; return {};
      case "playhead.step": st.playhead += p.frames * F; return {};
      case "transcript.inspect": return { words: [{ text: "hello", clip: 10 }, { text: "we're", clip: 13 }, { text: "at", clip: 13 }, { text: "Chili's", clip: 13 }] }; // words land on the audio half
      case "proposal.preview": {
        st.onPreview?.();
        if (st.proposal) throw new Error("edit proposal: cancel or commit the current preview before proposing another");
        if (p.expectedRevision !== st.revision) throw new Error("edit proposal: stale revision, different active sequence or active dynamic trim");
        st.previews.push(p);
        st.proposal = { token: st.next++, label: p.label, revision: st.revision, steps: p.steps };
        return { token: st.proposal.token, expectedRevision: p.expectedRevision, label: p.label, sequence: seq(), results: p.steps.map(step => step.command === "sequence.applyVideoTransition" ? {transition: 44} : {}) };
      }
      case "proposal.tools": return {tools: [{id: "effects.apply", args: ["effect"]}, {id: "effects.setParam", args: ["effect","param","value","time"]}, {id: "clip.audioGain", args: ["mode","db"]}], effects: []};
      case "proposal.inspect": {
        if (!st.proposal || st.proposal.revision !== st.revision) throw new Error("stale project preview");
        const sequence = seq(); sequence.video[0].transitions = [{id:44,start:290*F,duration:20*F}];
        return {token:st.proposal.token, expectedRevision:st.revision, label:st.proposal.label, sequence, results:[{transition:44}]};
      }
      case "proposal.render": {
        if (!st.proposal || st.proposal.revision !== st.revision) throw new Error("stale project preview");
        st.renders.push(p); return {width:1,height:1,rgba:[p.frame % 256,0,0,255]};
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
        if (req.method === "ui.set") { // waits on st.inkGate, so a test can hold one in flight
          st.ink.push(req.params.ink);
          Promise.resolve(st.inkGate).then(() => sock.write(JSON.stringify({ id: req.id, ok: true, result: {} }) + "\n"));
          continue;
        }
        let reply;
        try {
          if (req.method === "ui.screenshot") { // desktop: the PNG is written to the given path
            st.shots.push(req.params);
            writeFileSync(req.params.path, Buffer.alloc(st.shotSize, 7));
          }
          const result = req.method === "engine.commands" ? REQUIRED.map((id) => ({ id })) : req.method === "ui.inspect" ? { playhead: st.playhead }
            : req.method === "perf.stats" ? { monitor: {frame: st.monitorFrame ?? Math.floor(st.playhead / F), revision: st.monitorRevision ?? st.revision, projectRevision: st.revision, playheadFrame: Math.floor(st.playhead / F)} }
            : req.method === "ui.screenshot" ? { path: req.params.path, width: 8, height: 8 }
            : req.method === "ui.playback" ? (st.ui.push([req.params.action, req.params.speed]), st.playing = req.params.action === "play", { playing: st.playing, playhead: st.playhead })
            : exec(req.params.command, req.params.params);
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
    const a = answers.shift() ?? (prompts.at(-1)?.schema?.properties?.ok ? {ok:true,summary:"The timed frames show the requested transition."} : undefined);
    if (typeof a === "function") a();
    res.writeHead(200, { "content-type": "application/json" });
    const next = typeof a === "function" ? answers.shift() : a;
    res.end(JSON.stringify({ json: next && "ok" in next ? next : A(next) })); // a sketch reading is sent as is
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
  return { editor: editor.st, proxy, call, close, port };
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
  assert.match(prompt, /"id":12,"track":"V1","file":"C5517.MP4","start":10,"duration":5,"link":2,.*"says":"we're at Chili's"/);
  assert.match(prompt, /"linkedAudio":\[\{"id":11/); // audio tools can address the linked partner explicitly
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

test("remove and move preview exact proposal steps; accept commits one step, reject cancels", async (t) => {
  const s = await setup(); t.after(s.close);
  s.proxy.answers.push({ action: "remove", reply: "Removing the Chili's clip.", clips: [12] });
  let r = await s.call("/chat", { message: "remove the Chili's part" });
  assert.equal(r.body.reply, "Removing the Chili's clip. Preview ready: accept to apply it, or reject.");
  assert.deepEqual(s.editor.previews[0], { expectedRevision: 5, sequence: 27, label: "Remove C5517.MP4",
    steps: [{ command: "timeline.remove", params: { clips: [12] } }] });
  r = await s.call("/chat/accept", {});
  assert.deepEqual(s.editor.history, ["Remove C5517.MP4"]);
  s.proxy.answers.push({ action: "move", reply: "Moving.", clip: 12, target: 10, position: "before" });
  r = await s.call("/chat", { message: "put the Chili's part first" });
  assert.deepEqual(s.editor.previews[1], { expectedRevision: 6, sequence: 27, label: "Move C5517.MP4 before C5500.MP4",
    steps: [{ command: "timeline.move", params: { clip: 12, anchor: 10, position: "before" } }] });
  r = await s.call("/chat/reject", {});
  assert.equal(s.editor.proposal, null);
  assert.equal(s.editor.history.length, 1);
});

test("an engine refusal of a remove or move is reported and leaves nothing pending", async (t) => {
  const s = await setup(); t.after(s.close);
  s.editor.onPreview = () => { throw new Error("edit proposal: move cannot ripple every affected track identically (sync lock, gap or partner); re-plan"); };
  s.proxy.answers.push({ action: "move", reply: "Moving.", clip: 10, target: 12, position: "after" });
  const r = await s.call("/chat", { message: "put the first clip last" });
  assert.match(r.body.reply, /^The editor refused that move \(.*re-plan\)\. Nothing changed\.$/);
  assert.equal(r.body.pending, null);
});

test("long or non-ASCII clip names still fit the 120-byte proposal label", () => {
  assert.equal(fit("Remove C5500.MP4"), "Remove C5500.MP4");
  for (const s of ["x".repeat(500), "é".repeat(200), "日本".repeat(100), "🎬".repeat(100)]) {
    const label = fit(`Remove ${s}`);
    assert.ok(Buffer.byteLength(label) <= 120 && label.startsWith("Remove ") && label.endsWith("…"), label);
  }
});

test("invalid model output gets one retry quoting the error, then a polite refusal", async (t) => {
  const s = await setup(); t.after(s.close);
  s.proxy.answers.push({ action: "remove", reply: "x", clips: [99] }, { action: "remove", reply: "Removing.", clips: [12] });
  let r = await s.call("/chat", { message: "remove the Chili's part" });
  assert.match(s.proxy.prompts[1].prompt, /clip 99 is not a clip in the active sequence/);
  assert.match(r.body.reply, /^Removing\. Preview ready/);
  await s.call("/chat/reject", {});
  s.proxy.answers.push({ action: "delete_everything", reply: "x" }, { action: "trim", reply: "x", clip: 10, edge: "out", direction: "shorten", amount: 9999, unit: "frames" });
  r = await s.call("/chat", { message: "trim a lot" });
  assert.match(r.body.reply, /^Sorry, I couldn't.*only 300 frames long.*Nothing changed\.$/);
  assert.equal(s.editor.previews.length, 1); // only the valid retry was previewed
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
  snap.clips.set(14, { ...c(14, 1, 0, 30), track: "A2" });
  bad({ action: "move", reply: "r", clip: 10, target: 14, position: "after" }, /same track/);
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

// ---- Review playback (DEV-113)
test("review: stop captures the moment; a note binds to it, previews, accept commits and resumes", async (t) => {
  const s = await setup(); t.after(s.close);
  let r = await s.call("/review/stop", {});
  assert.deepEqual(r.body, { moment: { revision: 5, playhead: 400 * F, clip: 12 } });
  assert.equal(s.editor.playing, false);
  s.proxy.answers.push({ action: "remove", reply: "Removing that clip.", clips: [12] });
  r = await s.call("/review/note", { moment: r.body.moment, transcript: "this part drags, cut it", gestures: [{ type: "engage" }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.pending, { token: 1, label: "Remove C5517.MP4" });
  assert.equal((await s.call("/chat/state")).body.messages[0].text, "Review note at 13.33 s on clip 12: this part drags, cut it");
  assert.match(s.proxy.prompts[0].prompt, /Review note at 13\.33 s on clip 12/);
  assert.equal(s.editor.history.length, 0); // nothing applied without acceptance
  await s.call("/chat/accept", {});
  assert.deepEqual(s.editor.history, ["Remove C5517.MP4"]);
  assert.equal(s.editor.playing, true);
});

test("review: a scrub while talking marks a range; reject returns to the moment and plays", async (t) => {
  const s = await setup(); t.after(s.close);
  const { moment } = (await s.call("/review/stop", {})).body;
  assert.equal((await s.call("/review/transport", { event: { type: "step", frames: 30 } })).status, 200);
  s.proxy.answers.push({ action: "trim", reply: "ok", clip: 12, edge: "in", direction: "shorten", amount: 1, unit: "seconds" });
  await s.call("/review/note", { moment, transcript: "from here to here is dead air", gestures: [{ type: "step" }] });
  assert.match(s.proxy.prompts[0].prompt, /marking 13\.33–14\.33 s: from here to here is dead air/);
  await s.call("/chat/reject", {});
  assert.deepEqual(s.editor.ui.slice(-2), [["seek", 400 * F], ["play", undefined]]);
  assert.equal(s.editor.history.length, 0);
});

test("review: stale moment is a clear 409 shown in chat; cancel resumes", async (t) => {
  const s = await setup(); t.after(s.close);
  const { moment } = (await s.call("/review/stop", {})).body;
  s.editor.revision++;
  const r = await s.call("/review/note", { moment, transcript: "cut this" });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /changed since you stopped playback.*Nothing changed/);
  assert.equal(s.editor.previews.length, 0);
  assert.match((await s.call("/chat/state")).body.messages.at(-1).text, /changed since you stopped/);
  assert.deepEqual((await s.call("/review/cancel", {})).body, { resumed: true });
  assert.equal(s.editor.playing, true);
});

test("review transport and HTTP boundary: bridge drives playback; chop, hostile input refused; CORS preflight", async (t) => {
  const s = await setup(); t.after(s.close);
  assert.equal((await s.call("/review/transport", { event: { type: "shuttle", rate: -2 } })).status, 200);
  assert.deepEqual(s.editor.ui.at(-1), ["play", -2]);
  await s.call("/review/transport", { event: { type: "shuttle", rate: 0 } });
  assert.equal(s.editor.playing, false);
  assert.equal((await s.call("/review/transport", { event: { type: "chop" } })).body.error, "chop is a cut: POST /review/cut");
  for (const event of [null, { type: "rm" }, { type: "shuttle", rate: 1e9 }, { type: "step", frames: 0.5 }, { type: "swipe", direction: "up" }])
    assert.equal((await s.call("/review/transport", { event })).status, 400, JSON.stringify(event));
  assert.equal((await s.call("/review/stop", { x: 1 })).status, 400);
  const m = { revision: 5, playhead: 0, clip: null };
  for (const b of [{ transcript: "x" }, { moment: { ...m, extra: 1 }, transcript: "x" }, { moment: { ...m, playhead: -1 }, transcript: "x" },
    { moment: m, transcript: "" }, { moment: m, transcript: "x", gestures: [1] }, { moment: m, transcript: "x", gestures: Array(65).fill({ type: "a" }) }])
    assert.equal((await s.call("/review/note", b)).status, 400, JSON.stringify(b));
  assert.equal(s.proxy.prompts.length, 0);
  const pre = await fetch(`http://127.0.0.1:${s.port}/review/note`, { method: "OPTIONS", headers: { origin: "http://127.0.0.1:8771" } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "http://127.0.0.1:8771");
  assert.equal((await fetch(`http://127.0.0.1:${s.port}/review/note`, { method: "OPTIONS", headers: { origin: "https://evil.example" } })).status, 403);
});

// ---- Part 2 gestures (DEV-91): fist pause / slide transport, and the camera page's ink.
test("review transport: a fist pauses, a slide seeks from the paused playhead (no undo entry); double tap is gone", async (t) => {
  const s = await setup(); t.after(s.close);
  assert.equal((await s.call("/review/transport", { event: { type: "pause" } })).status, 200);
  assert.equal(s.editor.playing, false);
  assert.equal((await s.call("/review/transport", { event: { type: "slide", seconds: 2 } })).status, 200);
  assert.deepEqual(s.editor.ui.at(-1), ["seek", 400 * F + 2 * TPS]);
  await s.call("/review/transport", { event: { type: "slide", seconds: -500 } });
  assert.deepEqual(s.editor.ui.at(-1), ["seek", 0], "clamped at 0");
  await s.call("/review/transport", { event: { type: "cancel" } });
  assert.deepEqual(s.editor.ui.at(-1), ["seek", 400 * F], "Esc returns to where the fist closed");
  assert.deepEqual([s.editor.history, s.editor.revision], [[], 5]);
  for (const event of [{ type: "slide" }, { type: "slide", seconds: 1e6 }, { type: "slide", seconds: "1" }, { type: "double-tap" }, { type: "pointer", x: 0, y: 0 }])
    assert.equal((await s.call("/review/transport", { event })).status, 400, JSON.stringify(event));
});

test("/ink: forwards ui.set {ink}; skips the busy lock; coalesces to the latest while one is in flight", async (t) => {
  const s = await setup(); t.after(s.close);
  const ink = { pointer: [0.5, 0.25], strokes: [[[0.1, 0.2], [0.3, 0.4]]], drawing: true };
  assert.deepEqual(await s.call("/ink", ink), { status: 200, body: { ok: true } });
  assert.deepEqual(s.editor.ink, [ink]);
  // Busy with a chat: ink still goes through.
  const open = s.proxy.hold();
  s.proxy.answers.push({ action: "answer", reply: "ok" });
  const chat = s.call("/chat", { message: "hi" });
  while (!s.proxy.prompts.length) await new Promise((r) => setTimeout(r, 5));
  assert.equal((await s.call("/chat", { message: "again" })).status, 409);
  assert.equal((await s.call("/ink", { pointer: null, strokes: [], drawing: false })).status, 200);
  open(); await chat;
  // One ui.set in flight: of the bodies that arrive meanwhile only the newest is sent next.
  let release;
  s.editor.inkGate = new Promise((r) => (release = r));
  s.editor.ink.length = 0;
  const body = (x) => ({ pointer: [x, x], strokes: [], drawing: false });
  const sent = [s.call("/ink", body(0.1))];
  while (s.editor.ink.length < 1) await new Promise((r) => setTimeout(r, 5));
  for (const x of [0.2, 0.3]) { sent.push(s.call("/ink", body(x))); await new Promise((r) => setTimeout(r, 30)); }
  release();
  assert.ok((await Promise.all(sent)).every((r) => r.status === 200));
  assert.deepEqual(s.editor.ink.map((i) => i.pointer[0]), [0.1, 0.3]);
});

test("/ink is hostile-input safe: caps 20 strokes × 500 points, drops bad points, refuses bad shapes", async (t) => {
  const s = await setup(); t.after(s.close);
  const stroke = (k) => [[NaN, 0], [2, 0.5], ...Array.from({ length: 600 }, (_, i) => [k / 100, i / 600])];
  const r = await s.call("/ink", { pointer: null, strokes: [[], ...Array.from({ length: 25 }, (_, k) => stroke(k))], drawing: true });
  assert.equal(r.status, 200);
  const got = s.editor.ink.at(-1);
  assert.equal(got.strokes.length, 20);
  assert.ok(got.strokes.every((p) => p.length === 500));
  assert.deepEqual(got.strokes[0][0], [0.05, 0], "the newest 20 strokes are kept");
  for (const b of [{ pointer: [2, 0] }, { pointer: [0.5] }, { pointer: "x" }, { strokes: "x" }, { strokes: [7] }, { drawing: "yes" }, { extra: 1 }])
    assert.equal((await s.call("/ink", b)).status, 400, JSON.stringify(b));
  assert.equal((await s.call("/ink", JSON.stringify({ strokes: [[["x".repeat(600 * 1024)]]] }))).status, 413);
  assert.deepEqual(readInk({}), { pointer: null, strokes: [], drawing: false });
});

// ---- Freehand + explanation → one grounded multimodal edit.
const SKETCH = { pointer: null, strokes: [[[0.5, 0.2], [0.5, 0.8]], [[0.45, 0.5], [0.3, 0.5]], [[0.55, 0.5], [0.7, 0.5]]], drawing: false };

test("sketch: split figure + 'use this video afterwards' → move then split in one preview; accept commits; ink cleared", async (t) => {
  const s = await setup(); t.after(s.close);
  await s.call("/ink", SKETCH);
  s.proxy.answers.push({ action: "transition", reply: "Splitting into the first clip.", from: 12, to: 10, effect: "split", direction: "none" });
  const r = await s.call("/chat", { message: "use this video afterwards" });
  assert.match(r.body.reply, /^Splitting into the first clip\. Preview ready/);
  // The vision call: Program monitor screenshot + strokes, on the sketch model; the file is removed after.
  assert.deepEqual(s.editor.shots.map((p) => p.panel), ["program"]);
  assert.ok(!existsSync(s.editor.shots[0].path));
  const vision = s.proxy.prompts[0];
  assert.equal(vision.model, SKETCH_MODEL);
  assert.deepEqual(vision.images, [{ mimeType: "image/png", data: Buffer.alloc(64, 7).toString("base64") }]);
  assert.match(vision.prompt, /\[\[\[0\.5,0\.2\],\[0\.5,0\.8\]\]/);
  assert.equal(vision.schema.properties.figure, undefined);
  assert.match(vision.prompt, /use this video afterwards/);
  assert.match(vision.system, /CURRENT video clip 12/);
  assert.deepEqual(s.editor.previews[0].steps, [
    { command: "timeline.move", params: { clip: 10, anchor: 12, position: "after" } },
    { command: "sequence.applyVideoTransition", params: { clip: 12, effect: "split", edge: "out" } },
  ]);
  assert.equal(s.editor.ink.length, 1);
  const a = await s.call("/chat/accept", {});
  assert.match(a.body.reply, /^Applied "Move C5500\.MP4 after C5517\.MP4, split between"\. It's one undo step\.$/);
  assert.equal(s.editor.history.length, 1);
  assert.deepEqual(s.editor.ink.at(-1), null);
  // The camera keeps re-sending its stroke list: the decided strokes stay off; a new stroke shows.
  await s.call("/ink", { ...SKETCH, pointer: [0.2, 0.2] });
  assert.deepEqual(s.editor.ink.at(-1), { pointer: [0.2, 0.2], strokes: [], drawing: false });
  const fresh = [[0.1, 0.1], [0.2, 0.2]];
  await s.call("/ink", { ...SKETCH, strokes: [...SKETCH.strokes, fresh], drawing: true });
  assert.deepEqual(s.editor.ink.at(-1).strokes, [fresh]);
  await s.call("/ink", { pointer: null, strokes: [], drawing: false }); // the camera cleared: strokes count again
  await s.call("/ink", SKETCH);
  assert.deepEqual(s.editor.ink.at(-1), SKETCH);
  await s.call("/ink", { pointer: null, strokes: [], drawing: false });
  // The sketch is used up: the next message is a plain chat (no screenshot, no vision call).
  s.proxy.answers.push({ action: "answer", reply: "Done." });
  await s.call("/chat", { message: "thanks" });
  assert.equal(s.editor.shots.length, 1);
  assert.equal(s.proxy.prompts.length, 3);
});

test("sketch: explanation chooses a push with its direction (one step when the clip already follows); reject clears the ink", async (t) => {
  const s = await setup(); t.after(s.close);
  await s.call("/ink", SKETCH);
  s.proxy.answers.push({ action: "transition", reply: "Pushing left.", from: 10, to: 12, effect: "push", direction: "left" });
  await s.call("/chat", { message: "push to the next shot" });
  assert.deepEqual(s.editor.previews[0].steps, [{ command: "sequence.applyVideoTransition", params: { clip: 10, effect: "push", edge: "out", direction: "left" } }]);
  assert.equal(s.editor.previews[0].label, "Push from C5500.MP4 to C5517.MP4");
  const r = await s.call("/chat/reject", {});
  assert.match(r.body.reply, /^Discarded/);
  assert.equal(s.editor.history.length, 0);
  assert.deepEqual(s.editor.ink.at(-1), null);
  // The same strokes can request an iris when the explanation explicitly asks for it.
  await s.call("/ink", { pointer: null, strokes: [], drawing: false });
  await s.call("/ink", SKETCH);
  s.proxy.answers.push({ action: "transition", reply: "Iris.", from: 10, to: 12, effect: "iris_round", direction: "none" });
  await s.call("/chat", { message: "iris into the next one" });
  assert.equal(s.editor.previews[1].steps[0].params.effect, "iris_round");
});

test("sketch: ambiguous freehand intent asks for clarification and preserves ink", async (t) => {
  const s = await setup(); t.after(s.close);
  await s.call("/ink", SKETCH);
  s.proxy.answers.push({ action: "answer", reply: "Do you want a zoom on this area or an iris transition?" });
  const r = await s.call("/chat", { message: "do this" });
  assert.match(r.body.reply, /zoom.*iris/);
  assert.equal(r.body.pending, null);
  assert.equal(s.proxy.prompts.length, 1);
  assert.equal(s.editor.previews.length, 0);
  assert.deepEqual(s.editor.ink, [SKETCH]);
});

test("sketch: only a finished sketch is read; without one a transition action is invalid", async (t) => {
  const s = await setup(); t.after(s.close);
  await s.call("/ink", { ...SKETCH, drawing: true }); // still drawing
  s.proxy.answers.push({ action: "transition", reply: "x", from: 10, to: 12 }, { action: "answer", reply: "Draw it first." });
  const r = await s.call("/chat", { message: "split here" });
  assert.equal(r.body.reply, "Draw it first.");
  assert.equal(s.editor.shots.length, 0);
  assert.match(s.proxy.prompts[1].prompt, /transition needs a finished sketch/);
  assert.doesNotMatch(s.proxy.prompts[0].system, /transition:/);
});

test("sketch: oversized Program picture is refused before the vision call", async (t) => {
  const s = await setup(); t.after(s.close);
  s.editor.shotSize = MAX_IMAGE_BYTES + 1;
  await s.call("/ink", SKETCH);
  const r = await s.call("/chat", { message: "use this video afterwards" });
  assert.equal(r.status, 200);
  assert.match(r.body.reply, /too large.*Nothing changed\.$/);
  assert.equal(s.proxy.prompts.length, 0);
  assert.ok(!existsSync(s.editor.shots[0].path));
});

test("sketch: stale revision and an engine refusal are friendly replies, not 502", async (t) => {
  const s = await setup(); t.after(s.close);
  await s.call("/ink", SKETCH);
  s.proxy.answers.push(() => { s.editor.revision++; }, { action: "transition", reply: "ok", from: 10, to: 12, effect: "split", direction: "none" });
  let r = await s.call("/chat", { message: "use this video afterwards" });
  assert.equal(r.status, 200);
  assert.match(r.body.reply, /project changed.*send it again/);
  // The engine's own (non-proposal) error for the transition is reported, and nothing is pending.
  await s.call("/ink", { pointer: null, strokes: [], drawing: false });
  await s.call("/ink", SKETCH);
  s.editor.onPreview = () => { throw new Error("sequence.applyVideoTransition: no edit point at the playhead on targeted tracks"); };
  s.proxy.answers.push({ action: "transition", reply: "ok", from: 10, to: 12, effect: "split", direction: "none" });
  r = await s.call("/chat", { message: "use this video afterwards" });
  assert.equal(r.status, 200);
  assert.match(r.body.reply, /^The editor refused that transition \(.*no edit point.*\)\. Nothing changed\.$/);
  assert.equal(r.body.pending, null);
  assert.equal(s.editor.history.length, 0);
});

const CIRCLE_ARROWS = { pointer: null, drawing: false, strokes: [
  [[0.15, 0.2], [0.3, 0.15], [0.45, 0.2], [0.5, 0.4], [0.4, 0.6], [0.2, 0.6], [0.1, 0.4], [0.15, 0.2]],
  [[0.45, 0.2], [0.7, 0.1], [0.65, 0.18]], [[0.7, 0.1], [0.6, 0.08]],
]};
const ZOOM = { action: "zoom", reply: "Zooming twice into the circled subject.", clip: 12, region: [0.1, 0.15, 0.5, 0.6], factor: 2 };

test("circle with arrows and explanation reaches one vision request; grounded zoom previews, accepts and clears ink", async (t) => {
  const s = await setup(); t.after(s.close);
  await s.call("/ink", CIRCLE_ARROWS);
  s.proxy.answers.push(ZOOM);
  const r = await s.call("/chat", { message: "Zoom 2x into the circled area; arrows show it filling more of the frame." });
  assert.match(r.body.reply, /Preview ready/);
  assert.equal(s.proxy.prompts.length, 1);
  const request = s.proxy.prompts[0];
  assert.equal(request.model, SKETCH_MODEL);
  assert.ok(request.images[0].data);
  assert.match(request.prompt, /Zoom 2x into the circled area/);
  assert.ok(request.prompt.includes(JSON.stringify(CIRCLE_ARROWS.strokes)));
  assert.match(request.system, /no fixed shape vocabulary/);
  assert.deepEqual(s.editor.previews[0].steps, [{ command: "clip.zoomRegion", params: { clip: 12, region: ZOOM.region, factor: 2 } }]);
  assert.equal(s.editor.revision, 5);
  await s.call("/chat/accept", {});
  assert.equal(s.editor.history.length, 1);
  assert.equal(s.editor.ink.at(-1), null);
});

test("zoom rejects invented or non-current targets, hostile regions and magnification", () => {
  const snap = { clips: new Map([[12, {clip: 12, track: "V1"}], [10, {clip: 10, track: "V1"}], [13, {clip: 13, track: "A1"}]]) };
  for (const x of [{...ZOOM, clip: 10}, {...ZOOM, clip: 99}, {...ZOOM, clip: 13}, {...ZOOM, factor: NaN},
    {...ZOOM, factor: 5}, {...ZOOM, region: [0.8, 0, 0.2, 1]}, {...ZOOM, region: [0, 0, 0.01, 1]},
    {...ZOOM, region: [0, 0, 1, 2]}, {...ZOOM, region: [0, 0, 1]}, {...ZOOM, region: [0, Infinity, 1, 1]}]) {
    assert.throws(() => validateAction(A(x), snap, {clip: 12}));
  }
  assert.throws(() => validateAction(A(ZOOM), snap));
});

test("zoom refuses a moved frame before calling the model and a changed drawing during inference", async (t) => {
  const s = await setup(); t.after(s.close);
  await s.call("/ink", CIRCLE_ARROWS);
  s.editor.playhead += F;
  let r = await s.call("/chat", {message: "zoom 2x here"});
  assert.match(r.body.reply, /frame or project changed/);
  assert.equal(s.proxy.prompts.length, 0);
  s.editor.playhead -= F;
  const open = s.proxy.hold();
  s.proxy.answers.push(ZOOM);
  const result = s.call("/chat", {message: "zoom 2x here"});
  while (!s.proxy.prompts.length) await new Promise(r => setTimeout(r, 5));
  await s.call("/ink", {...CIRCLE_ARROWS, strokes: [[[0.7, 0.8], [0.8, 0.9]]]});
  open();
  r = await result;
  assert.match(r.body.reply, /drawing, frame or project changed/);
  assert.equal(s.editor.previews.length, 0);
});

test("review explanation and freehand use the same multimodal path; reject preserves project", async (t) => {
  const s = await setup(); t.after(s.close);
  await s.call("/ink", CIRCLE_ARROWS);
  const stop = await s.call("/review/stop", {});
  s.proxy.answers.push(ZOOM);
  const r = await s.call("/review/note", {moment: stop.body.moment, transcript: "stop, zoom twice into the circled subject"});
  assert.match(r.body.reply, /Preview ready/);
  assert.match(s.proxy.prompts[0].prompt, /Review note.*zoom twice/);
  assert.ok(s.proxy.prompts[0].images.length);
  await s.call("/chat/reject", {});
  assert.equal(s.editor.revision, 5);
  assert.equal(s.editor.history.length, 0);
  assert.equal(s.editor.ink.at(-1), null);
});

test("deciding a sketch preserves newer ink, and repeated consumed camera ink never pauses resumed playback", async (t) => {
  const s = await setup(); t.after(s.close);
  await s.call("/ink", CIRCLE_ARROWS);
  s.proxy.answers.push(ZOOM);
  await s.call("/chat", {message: "zoom twice here"});
  const fresh = [[0.7, 0.8], [0.8, 0.9]];
  await s.call("/ink", {...CIRCLE_ARROWS, strokes: [...CIRCLE_ARROWS.strokes, fresh]});
  await s.call("/chat/reject", {});
  assert.deepEqual(s.editor.ink.at(-1).strokes, [fresh]);
  await s.call("/ink", {pointer: null, strokes: [], drawing: false});
  await s.call("/ink", CIRCLE_ARROWS);
  s.proxy.answers.push(ZOOM);
  await s.call("/chat", {message: "zoom twice here"});
  await s.call("/chat/accept", {});
  const before = s.editor.ui.length;
  for (let i = 0; i < 3; i++) await s.call("/ink", CIRCLE_ARROWS);
  assert.equal(s.editor.ui.length, before, "consumed ink must not trigger another pause");
  assert.deepEqual(s.editor.ink.at(-1).strokes, []);
});


test("sketch refuses a monitor picture still showing an older frame or revision", async (t) => {
  const s = await setup(); t.after(s.close);
  await s.call("/ink", CIRCLE_ARROWS);
  s.editor.monitorFrame = 1;
  let r = await s.call("/chat", {message: "zoom twice here"});
  assert.match(r.body.reply, /hasn't rendered this frame/);
  s.editor.monitorFrame = null;
  s.editor.monitorRevision = 4;
  r = await s.call("/chat", {message: "zoom twice here"});
  assert.match(r.body.reply, /hasn't rendered this frame/);
  assert.equal(s.proxy.prompts.length, 0);
  assert.equal(s.editor.shots.length, 0);
});

test("assistant stages runtime-approved effect tools as one multi-command preview; navigation does not edit", async (t) => {
  const s = await setup(); t.after(s.close);
  s.proxy.answers.push({action:"edit",reply:"Blur this clip.",steps:[{command:"effects.apply",clips:[12],argsJson:'{"effect":"gaussian_blur"}'},{command:"effects.setParam",clips:[12],argsJson:'{"effect":"gaussian_blur","param":"radius","value":12}'}]});
  const r=await s.call("/chat",{message:"blur the current clip"});
  assert.match(r.body.reply,/Preview ready/);
  assert.deepEqual(s.editor.previews[0].steps.map(s => s.params.id), ["effects.apply","effects.setParam"]);
  assert.match(s.proxy.prompts[0].prompt,/APPROVED EDITING TOOLS/);
  await s.call("/chat/accept",{});
  assert.equal(s.editor.history.length,1);
  s.proxy.answers.push({action:"navigate",reply:"Moved one frame.",operation:"step",value:1});
  await s.call("/chat",{message:"step one frame"});
  assert.equal(s.editor.history.length,1);
  assert.equal(s.editor.playhead,401*F);
});

test("assistant tool input rejects arbitrary commands, implicit targets and target injection", () => {
  const snap={clips:new Map([[12,{clip:12,track:"V1"}]]),tools:[{id:"effects.apply",args:["effect"]}]};
  for(const step of [{command:"file.exportMedia",clips:[12],argsJson:'{}'}, {command:"effects.apply",clips:[],argsJson:'{}'},
    {command:"effects.apply",clips:[12],argsJson:'{"effect":"blur","clip":99}'}, {command:"effects.apply",clips:[99],argsJson:'{}'},
    {command:"effects.apply",clips:[12],argsJson:'[]'}, {command:"effects.apply",clips:[12],argsJson:'bad'}]) assert.throws(()=>validateAction(A({action:"edit",reply:"x",steps:[step]}),snap));
});

test("staged transition is rendered and visually inspected before acceptance; temporal evidence expires on decision", async(t)=>{
  const s=await setup();t.after(s.close);
  await s.call("/ink",SKETCH);
  s.proxy.answers.push({action:"transition",reply:"Split these shots.",from:10,to:12,effect:"split",direction:"none"});
  const r=await s.call("/chat",{message:"split into the next shot"});
  assert.equal(r.body.pending.rendered,true);
  assert.equal(s.editor.renders.length,5);
  assert.equal(s.proxy.prompts[1].images.length,5);
  assert.match(s.proxy.prompts[1].system,/chronological order/);
  const p=await s.call("/chat/preview");assert.equal(p.status,200);assert.equal(p.body.frames.length,5);
  assert.equal(s.editor.history.length,0);
  await s.call("/chat/reject",{});
  assert.equal((await s.call("/chat/preview")).status,409);
  assert.equal(s.editor.revision,5);
});

test("failed visual transition review cancels staging and offers no acceptance",async(t)=>{
  const s=await setup();t.after(s.close);
  await s.call("/ink",SKETCH);
  s.proxy.answers.push({action:"transition",reply:"Split.",from:10,to:12,effect:"split",direction:"none"},{ok:false,summary:"The frames do not show the requested direction."});
  const r=await s.call("/chat",{message:"split to the next shot"});
  assert.match(r.body.reply,/rendered transition needs clarification/);
  assert.equal(r.body.pending,null);assert.equal(s.editor.proposal,null);assert.equal(s.editor.history.length,0);
});
