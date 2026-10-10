// Assembles a servable demo: a prebuilt editor dist + shway/*.js modules + the surface pages.
// node surface/build-demo.mjs <editor dist> --out <target/… or dist/… directory>
// Then: python3 -m http.server -d <out> 8765 --bind 127.0.0.1 → http://127.0.0.1:8765/demo.html
import { cp, mkdir, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const at = args.indexOf("--out");
const out = at >= 0 ? args[at + 1] : undefined;
const editor = args.find((a, i) => a !== "--out" && i !== at + 1);
if (!editor || !out) {
  console.error("Usage: node surface/build-demo.mjs <editor dist> --out <target/ or dist/ directory>");
  process.exit(2);
}
const src = resolve(editor), dst = resolve(out);
const inside = (a, b) => { const r = relative(a, b); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };
if (inside(src, dst) || inside(dst, src)) { console.error("The output must not overlap the editor dist (it is copied, never modified)."); process.exit(2); }
if (!(await stat(resolve(src, "index.html")).catch(() => null))) { console.error(`${src} has no index.html; build it with cargo xtask web.`); process.exit(2); }

await mkdir(dst, { recursive: true });
await cp(src, dst, { recursive: true });
// adapter.js, takes.js (and firstcut.js / replace.js once shway/build.mjs emits them). It refuses
// outputs outside this checkout's target/ or dist/.
execFileSync(process.execPath, [resolve(here, "../shway/build.mjs"), "--out", dst], { stdio: "inherit" });
for (const f of ["demo.html", "demo.mjs", "gestures/recognizer.mjs", "gestures/bridge.mjs", "gestures/hands.mjs",
  "gestures/camera.html", "voice/utterance.mjs", "voice/mic.mjs", "voice/voice.html"]) {
  await mkdir(dirname(resolve(dst, f)), { recursive: true });
  await cp(resolve(here, f), resolve(dst, f));
}
console.log(`Demo ready in ${dst}\nServe: python3 -m http.server -d ${relative(process.cwd(), dst) || "."} 8765 --bind 127.0.0.1\nOpen:  http://127.0.0.1:8765/demo.html`);
