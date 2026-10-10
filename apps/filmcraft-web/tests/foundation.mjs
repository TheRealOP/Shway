// Source-backed browser foundation gate. Node >=22, Chrome, ffprobe and ffmpeg.
// Serve a generated H.264/AAC MP4 next to index.html; do not commit fixtures.
// node apps/filmcraft-web/tests/foundation.mjs --url http://127.0.0.1:8765/ --media web-test.mp4 --out /tmp/fc-foundation
// Verifies same-page save/reopen; OPFS recovery across reload is a separate gate.
// --creator --transcript <word-timed JSON> [--proxy http://127.0.0.1:8790] [--decider gemini|jev]: replace the synthetic trim
// with the AI first cut + replacement chain (creator.mjs), then save/reopen/export that result.
import assert from "node:assert/strict";
import {checkProposals} from "./proposals.mjs";
import {checkTranscripts} from "./transcripts.mjs";
import {checkCreator} from "./creator.mjs";
import {spawn, execFile} from "node:child_process";
import {mkdirSync, writeFileSync, readFileSync, statSync, mkdtempSync, rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {promisify} from "node:util";

const arg = (key, fallback) => {
  const i = process.argv.indexOf(`--${key}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const out = arg("out", join(tmpdir(), "filmcraft-foundation"));
mkdirSync(out, {recursive: true});
const report = {ok: false, steps: {}, gates: {}};
const logs = [];
const pending = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let proc, ws, profile, spawnError, nextId = 1;
const run = promisify(execFile);

function send(method, params = {}, timeout = 30000) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error("Chrome connection closed"));
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, timeout);
    pending.set(id, {
      resolve: value => {clearTimeout(timer); resolve(value);},
      reject: error => {clearTimeout(timer); reject(error);},
    });
    try {ws.send(JSON.stringify({id, method, params}));}
    catch (error) {pending.get(id).reject(error); pending.delete(id);}
  });
}

function disconnect(error) {
  for (const waiter of pending.values()) waiter.reject(error);
  pending.clear();
}

async function evaluate(expression, timeout = 30000) {
  const value = await send("Runtime.evaluate", {expression, awaitPromise: true, returnByValue: true, timeout}, timeout + 1000);
  if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text);
  return value.result.value;
}

const execute = (command, params = {}) => evaluate(`filmcraft.execute(${JSON.stringify(command)}, ${JSON.stringify(params)})`);
const inspect = () => evaluate("filmcraft.inspect()");
async function until(test, timeout, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await test();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`Timeout: ${label}`);
}
function gate(name, value, context) {
  report.gates[name] = Boolean(value);
  assert(value, `${name}: ${JSON.stringify(context)}`);
}
async function screenshot(name) {
  const {data} = await send("Page.captureScreenshot", {format: "png"});
  const path = join(out, `${name}.png`);
  writeFileSync(path, Buffer.from(data, "base64"));
  return path;
}
// Excludes view state; includes track settings, source ranges, links, effects and transitions.
function timeline(sequence) {
  return {id: sequence.id, settings: sequence.settings, duration: sequence.duration, video: sequence.video, audio: sequence.audio};
}
function clips(sequence) {return [...sequence.video, ...sequence.audio].flatMap(track => track.items);}

try {
  const url = new URL(arg("url", "http://127.0.0.1:8765/"));
  url.searchParams.set("fresh", ""); url.searchParams.set("empty", "");
  report.url = url.href;
  const media = new URL(arg("media", "web-test.mp4"), url).href;
  report.media = media;
  const chrome = arg("chrome", process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");
  const downloads = mkdtempSync(join(out, "downloads-"));
  // A unique profile isolates OPFS, browser state and the debugging endpoint.
  profile = mkdtempSync(join(tmpdir(), "fc-foundation-chrome-"));
  proc = spawn(chrome, [
    ...(process.argv.includes("--headed") ? [] : ["--headless=new"]),
    "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--enable-unsafe-webgpu", "--mute-audio",
    "--autoplay-policy=no-user-gesture-required", "--window-size=1600,1000", "about:blank",
  ], {stdio: "ignore"});
  proc.on("error", error => {spawnError = error; disconnect(error);});
  // Discover only the endpoint written by our Chrome process, avoiding existing sessions.
  const port = await until(async () => {
    if (spawnError) throw spawnError;
    if (proc.exitCode !== null) throw new Error(`Chrome exited: ${proc.exitCode}`);
    try {
      const value = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
      return Number.isInteger(value) && value > 0 && value <= 65535 ? value : false;
    } catch {return false;}
  }, 15000, "Chrome debugging endpoint");
  const page = await until(async () => {
    if (spawnError) throw spawnError;
    if (proc.exitCode !== null) throw new Error(`Chrome exited: ${proc.exitCode}`);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, {signal: AbortSignal.timeout(1000)})).json();
      return list.find(tab => tab.type === "page" && tab.url === "about:blank");
    } catch {return false;}
  }, 15000, "Chrome startup");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {ws.close(); reject(new Error("WebSocket connection timeout"));}, 5000);
    ws.onopen = () => {clearTimeout(timer); resolve();};
    ws.onerror = () => {clearTimeout(timer); reject(new Error("WebSocket connection failed"));};
  });
  ws.onclose = () => disconnect(new Error("Chrome connection closed"));
  ws.onerror = () => disconnect(new Error("Chrome connection failed"));
  ws.onmessage = message => {
    try {
      const value = JSON.parse(message.data);
      const waiter = pending.get(value.id);
      if (waiter) {
        pending.delete(value.id);
        if (value.error) waiter.reject(new Error(value.error.message)); else waiter.resolve(value.result);
      } else if (value.method === "Runtime.consoleAPICalled") {
        logs.push(value.params.args.map(a => a.value ?? a.description ?? "").join(" "));
      } else if (value.method === "Runtime.exceptionThrown") {
        logs.push("EXCEPTION " + JSON.stringify(value.params.exceptionDetails));
      }
      if (logs.length > 200) logs.shift();
    } catch (error) {disconnect(error);}
  };
  await send("Page.enable"); await send("Runtime.enable");
  await send("Browser.setDownloadBehavior", {behavior: "allow", downloadPath: downloads});
  await send("Emulation.setDeviceMetricsOverride", {width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false});
  await send("Page.navigate", {url: url.href});
  await until(() => evaluate("Boolean(window.filmcraftLoad?.readyMs || window.filmcraftLoad?.error)"), 120000, "app readiness");
  report.load = await evaluate("window.filmcraftLoad");
  gate("load", !report.load.error, report.load);
  report.info = await evaluate("filmcraft.info()");
  await execute("file.newProject", {name: "Foundation"});
  report.steps.import = await evaluate(`filmcraft.importUrl(${JSON.stringify(media)})`, 120000);
  gate("import", report.steps.import.items?.length === 1 && report.steps.import.errors?.length === 0, report.steps.import);
  report.steps.sequence = await execute("file.newSequence", {name: "Foundation cut", fromItem: report.steps.import.items[0]});
  const baseline = await execute("sequence.inspect");
  report.steps.baseline = baseline;
  const video = baseline.video.flatMap(track => track.items);
  const audio = baseline.audio.flatMap(track => track.items);
  gate("sourceBackedAV", video.length === 1 && audio.length > 0 && clips(baseline).every(clip => clip.item === report.steps.import.items[0]), baseline);
  gate("linkedAV", video[0].link != null && audio.some(clip => clip.link === video[0].link), baseline);
  await execute("playhead.set", {time: 0});
  const beforeWarmup = await inspect();
  const warmupStarted = Date.now();
  await evaluate("filmcraft.request('ui.playback', {action:'play'})");
  await until(async () => {
    const value = await inspect();
    return value.playhead > beforeWarmup.playhead && value.playback.shown > 0 ? value : false;
  }, 30000, "source playback advancement and displayed frames");
  const startupMs = Date.now() - warmupStarted;
  await evaluate("filmcraft.request('ui.playback', {action:'stop'})");
  // Restart at zero after bounded warmup so the short fixture has a full sampling interval.
  await execute("playhead.set", {time: 0});
  await evaluate("filmcraft.request('ui.playback', {action:'play'})");
  const beforePlay = await inspect();
  const sampleStarted = Date.now();
  const samples = [];
  while (Date.now() - sampleStarted < 2000) {
    await sleep(250);
    const value = await evaluate("filmcraft.inspect()", 5000);
    samples.push({wallMs: Date.now() - sampleStarted, playhead: value.playhead, ...value.playback});
  }
  const playing = await inspect();
  const wallMs = Date.now() - sampleStarted;
  await evaluate("filmcraft.request('ui.playback', {action:'stop'})");
  const sourceSeconds = (playing.playhead - beforePlay.playhead) / 254016000000;
  const shown = playing.playback.shown - beforePlay.playback.shown;
  const dropped = playing.playback.dropped - beforePlay.playback.dropped;
  report.steps.playback = {
    startupMs, wallMs, sourceSeconds, shown, dropped,
    shownPerWallSecond: shown / (wallMs / 1000),
    sourceToWallRatio: sourceSeconds / (wallMs / 1000),
    before: beforePlay, after: playing, samples,
    screenshot: await screenshot("01-source-playback"),
  };
  gate("playback", sourceSeconds >= 1 && shown > 0, report.steps.playback);

  if (process.argv.includes("--transcripts")) {
    report.steps.transcripts = await checkTranscripts({evaluate});
    gate("transcriptIntegration", report.steps.transcripts.ok, report.steps.transcripts);
  }

  if (process.argv.includes("--proposals")) {
    report.steps.proposals = await checkProposals({evaluate, screenshot});
    gate("proposalIntegration", report.steps.proposals.ok, report.steps.proposals);
  }

  let accepted;
  if (process.argv.includes("--creator")) {
    report.steps.creator = await checkCreator({evaluate, item: report.steps.import.items[0], transcriptPath: arg("transcript"), proxy: arg("proxy", "http://127.0.0.1:8790"), decider: arg("decider", "gemini")});
    gate("creatorChain", report.steps.creator.ok, report.steps.creator);
    accepted = await execute("sequence.inspect");
    report.steps.creator.screenshot = await screenshot("02-creator-cut");
  } else {
    const trimFrames = 15;
    gate("fixtureLongEnough", video[0].durationFrames > trimFrames + 1, video[0]);
    const historyBefore = await execute("history.list");
    report.steps.trim = await execute("timeline.trim", {clip: video[0].clip, edge: "out", mode: "regular", deltaFrames: -trimFrames});
    const trimmed = await execute("sequence.inspect");
    const changed = clips(trimmed);
    const delta = report.steps.trim.delta;
    const linked = clips(baseline).filter(clip => clip.link === video[0].link);
    gate("linkedTrim", delta < 0 && trimmed.video[0].items[0].durationFrames === video[0].durationFrames - trimFrames && linked.length >= 2 && linked.every(original => {
      const after = changed.find(clip => clip.clip === original.clip);
      return after && after.duration === original.duration + delta && after.sourceOut === original.sourceOut + delta && after.start === original.start && after.sourceIn === original.sourceIn;
    }), {delta, baseline, trimmed});
    const historyAfter = await execute("history.list");
    gate("oneUndoStep", historyAfter.undo.length === historyBefore.undo.length + 1, {historyBefore, historyAfter});
    const undone = await execute("edit.undo");
    const restored = await execute("sequence.inspect");
    gate("undoRestoresAV", undone.undone === "Trim" && JSON.stringify(timeline(restored)) === JSON.stringify(timeline(baseline)), {undone, restored});
    const redone = await execute("edit.redo");
    accepted = await execute("sequence.inspect");
    gate("redoRestoresEdit", redone.redone === "Trim" && JSON.stringify(timeline(accepted)) === JSON.stringify(timeline(trimmed)), {redone, accepted});
    report.steps.edit = {trimmed, restored, accepted, historyBefore, historyAfter, screenshot: await screenshot("02-edited")};
  }

  const projectPath = "/projects/foundation.fcproj";
  report.steps.save = await execute("file.save", {path: projectPath});
  gate("savedBytes", report.steps.save.bytes > 0, report.steps.save);
  // Change the live timeline first, so reopening must actually restore saved state.
  await execute("edit.undo");
  report.steps.reopen = await execute("file.open", {path: projectPath});
  const reopened = await execute("sequence.inspect");
  const project = await execute("project.inspect");
  gate("saveReopen", report.steps.reopen.missingMedia === 0 && !project.dirty && JSON.stringify(timeline(reopened)) === JSON.stringify(timeline(accepted)), {reopen: report.steps.reopen, project, reopened});
  report.steps.reopenedTimeline = reopened;

  const exportPath = "/exports/foundation.mp4";
  const started = await execute("file.exportMedia", {format: "h264", path: exportPath, bitrateKbps: 4000, range: "entire", audio: true});
  const job = await until(async () => (await execute("jobs.list")).find(value => value.id === started.job && value.finished), 300000, "H.264 export");
  report.steps.export = {started, job};
  gate("exportSuccess", job.result && !job.result.error && job.result.frames > 0 && job.result.bytes > 0, job);
  const files = await evaluate("filmcraft.files()");
  gate("virtualExport", files.some(file => file.path === exportPath && file.size > 0), files);
  const downloadedPath = join(downloads, "foundation.mp4");
  await until(async () => {try {return statSync(downloadedPath).size === job.result.bytes;} catch {return false;}}, 15000, "complete MP4 download");
  const probe = await run(arg("ffprobe", "ffprobe"), ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", downloadedPath], {timeout: 30000, maxBuffer: 1 << 20});
  report.steps.export.probe = JSON.parse(probe.stdout);
  const streams = report.steps.export.probe.streams;
  gate("h264AAC", streams.some(stream => stream.codec_type === "video" && stream.codec_name === "h264") && streams.some(stream => stream.codec_type === "audio" && stream.codec_name === "aac"), streams);
  gate("exportFrameCount", streams.some(stream => stream.codec_type === "video" && Number(stream.nb_read_frames) === job.result.frames), streams);
  const rate = reopened.settings.frame_rate ?? reopened.settings.frameRate;
  const tolerance = rate ? 2 * rate.den / rate.num : 0.1;
  const expectedSeconds = reopened.duration / 254016000000;
  gate("exportDuration", Math.abs(Number(report.steps.export.probe.format.duration) - expectedSeconds) <= tolerance, {expectedSeconds, tolerance, actual: report.steps.export.probe.format.duration});
  const decode = await run(arg("ffmpeg", "ffmpeg"), ["-v", "error", "-xerror", "-i", downloadedPath, "-f", "null", "-"], {timeout: 60000, maxBuffer: 1 << 20});
  gate("exportDecodes", !decode.stderr.trim(), decode.stderr);
  report.steps.export.download = {path: downloadedPath, bytes: statSync(downloadedPath).size};
  report.steps.export.screenshot = await screenshot("03-exported");
  await inspect();
  gate("noPanic", !logs.some(line => /panicked at|RuntimeError|EXCEPTION/.test(line)) && !(await evaluate("window.filmcraftLoad.fatal || null")), logs);
  report.ok = true;
} catch (error) {
  report.error = String(error?.stack ?? error);
  try {report.failureScreenshot = await screenshot("99-failure");} catch {}
} finally {
  report.console = logs;
  disconnect(new Error("Foundation gate finished"));
  try {ws?.close();} catch {}
  if (proc && proc.exitCode === null && !spawnError) {
    const closed = new Promise(resolve => proc.once("close", resolve));
    proc.kill("SIGTERM");
    await Promise.race([closed, sleep(2000)]);
    if (proc.exitCode === null) {
      proc.kill("SIGKILL");
      await Promise.race([closed, sleep(2000)]);
    }
  }
  // Never recursively remove a profile while Chrome could still be using it.
  if (profile && (!proc || spawnError || proc.exitCode !== null || proc.signalCode !== null)) {
    try {rmSync(profile, {recursive: true, force: true});} catch (error) {report.cleanupError = String(error);}
  }
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
process.exit(report.ok ? 0 : 1);
