// Bounded temporal evidence from the existing staged renderer. No live project/playhead changes.
import { deflateSync } from "node:zlib";
const TPS = 254016000000;
function crc(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c ^= byte;
    for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
const chunk = (name, data) => {
  const type = Buffer.from(name), len = Buffer.alloc(4), checksum = Buffer.alloc(4);
  len.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(Buffer.concat([type, data])));
  return Buffer.concat([len, type, data, checksum]);
};
export function png({width, height, rgba}) {
  if (![width, height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 256) || !(rgba instanceof Uint8Array) || rgba.length !== width * height * 4) throw new Error("invalid bounded preview pixels");
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const rows = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) rows.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (1 + width * 4) + 1);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

export async function transitionFrames(adapter, token, frameTicks, transitionId) {
  const p = await adapter.inspectPreview(token);
  const transitions = p.sequence.video.flatMap(track => track.transitions ?? []);
  const t = transitions.find(t => t.id === transitionId);
  if (!t || ![t.start, t.duration, frameTicks].every(n => Number.isSafeInteger(n)) || t.start < 0 || t.duration <= 0 || frameTicks <= 0) throw new Error("staged transition has no bounded timing");
  const last = Math.max(0, Math.ceil(p.sequence.duration / frameTicks) - 1);
  const times = [t.start - frameTicks, t.start + t.duration / 4, t.start + t.duration / 2, t.start + t.duration * 3 / 4, t.start + t.duration + frameTicks];
  const indices = [...new Set(times.map(time => Math.max(0, Math.min(last, Math.floor(time / frameTicks)))))];
  if (indices.length < 3) throw new Error("transition interval is too short for temporal inspection");
  const frames = [];
  for (const frame of indices) {
    const pixels = await adapter.previewFrame(token, frame, 128);
    frames.push({frame, timeSeconds: frame * frameTicks / TPS, image: `data:image/png;base64,${png(pixels).toString("base64")}`});
  }
  return {token, startSeconds: t.start / TPS, durationSeconds: t.duration / TPS, frames};
}
