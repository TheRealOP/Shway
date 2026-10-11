import {test} from "node:test";
import assert from "node:assert/strict";
import {inflateSync} from "node:zlib";
import {png, transitionFrames} from "./preview.mjs";

test("preview PNG encodes exact bounded RGBA pixels", () => {
  const rgba = new Uint8Array([12,34,56,255, 90,80,70,255]);
  const file = png({width:2,height:1,rgba});
  assert.deepEqual([...file.subarray(0,8)], [137,80,78,71,13,10,26,10]);
  let at=8, compressed=[];
  while(at < file.length) { const n=file.readUInt32BE(at), type=file.toString("ascii",at+4,at+8); if(type === "IDAT") compressed.push(file.subarray(at+8,at+8+n)); at += n+12; }
  assert.deepEqual([...inflateSync(Buffer.concat(compressed))], [0,...rgba]);
  for (const p of [{width:0,height:1,rgba}, {width:257,height:1,rgba}, {width:2,height:1,rgba:new Uint8Array(3)}]) assert.throws(() => png(p));
});

test("transition temporal evidence renders five ordered token-scoped frames and never commits or seeks", async () => {
  const calls=[];
  const a={inspectPreview: async token => ({sequence:{duration:1000,video:[{transitions:[{id:44,start:100,duration:100}]}]}}), previewFrame:async(...args)=>{calls.push(args);return {width:1,height:1,rgba:new Uint8Array([1,2,3,255])};}};
  const p=await transitionFrames(a,7,10,44);
  assert.deepEqual(calls, [[7,9,128],[7,12,128],[7,15,128],[7,17,128],[7,21,128]]);
  assert.equal(p.frames.length,5);
  assert.ok(p.frames.every(f => f.image.startsWith("data:image/png;base64,")));
  await assert.rejects(transitionFrames(a,7,10,99), /bounded timing/);
});
