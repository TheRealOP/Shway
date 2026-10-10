// Node >=26. Emits dependency-free browser ESM into an ignored target/ or dist/ directory.
// node shway/build.mjs --out target/agent-foundation/web/dist
import {stripTypeScriptTypes} from "node:module";
import {readFile, writeFile, mkdir} from "node:fs/promises";
import {dirname, resolve, relative, sep} from "node:path";
import {fileURLToPath} from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const index = process.argv.indexOf("--out");
if (index < 0 || !process.argv[index + 1]) throw new Error("Usage: node shway/build.mjs --out <target/ or dist/ directory>");
const out = resolve(process.argv[index + 1]);
const rel = relative(root, out);
if (!["target", "dist"].some(name => rel === name || rel.startsWith(name + sep))) throw new Error("Output must be inside this checkout's ignored target/ or dist/ directory");
await mkdir(out, {recursive: true});
const source = await readFile(new URL("./adapter.ts", import.meta.url), "utf8");
const javascript = stripTypeScriptTypes(source, {mode: "strip"});
const destination = resolve(out, "adapter.js");
await writeFile(destination, javascript);
console.log(destination);
