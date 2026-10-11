// Browser-only camera pieces shared by camera.html and ../demo.html: open the camera, run MediaPipe
// Hand Landmarker (Apache-2.0, loaded from public CDNs at runtime; nothing vendored), draw the overlay.
import { DEFAULTS as C } from "./recognizer.mjs";

const VISION = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

/** Starts the camera into `video` and waits for its size. Throws the getUserMedia error. */
export async function openCamera(video) {
  video.srcObject = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
  await new Promise((ok) => (video.readyState >= 1 ? ok() : video.addEventListener("loadedmetadata", ok, { once: true })));
}

/** Runs the landmarker on every video frame: onFrame(t, captureT, hand | null), t = performance.now(). */
export async function runHands(video, onFrame) {
  const { FilesetResolver, HandLandmarker } = await import(`${VISION}/vision_bundle.mjs`);
  const fileset = await FilesetResolver.forVisionTasks(`${VISION}/wasm`);
  const landmarker = await HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL, delegate: "GPU" }, runningMode: "VIDEO", numHands: 1,
  });
  let last = -1;
  const frame = (now, meta) => {
    const t = performance.now();
    if (t > last) {
      last = t;
      const r = landmarker.detectForVideo(video, t);
      const hand = r.landmarks?.[0] && r.worldLandmarks?.[0] ? {
        image: r.landmarks[0], world: r.worldLandmarks[0],
        handedness: r.handedness?.[0]?.[0]?.categoryName ?? "", score: r.handedness?.[0]?.[0]?.score ?? 0,
      } : null;
      onFrame(t, meta?.captureTime ?? now, hand);
    }
    video.requestVideoFrameCallback(frame);
  };
  video.requestVideoFrameCallback(frame);
}

/** Big on-video text for a discrete gesture, or null. */
export function flashFor(e, t) {
  const text = { swipe: e.direction === "right" ? "→" : "←", "draw-toggle": e.drawing ? "✎ draw" : "✎ done", pause: "❚❚", chop: "✂ cut" }[e.type];
  return text ? { text, until: t + 600 } : null;
}

// ---- Overlay: skeleton, 🤘 meter, twist dial, swipe flash. Drawn in unmirrored canvas space
// with x flipped so it lines up with the mirrored video and text stays readable.
const BONES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
const COLORS = { Idle: "#bbb", Armed: "#2c9", Adjusting: "#3cf", TrackingLost: "#f80", Cancelled: "#f80" };
export const LABELS = { Idle: "🤘 or hold Space to scrub", Fist: "paused — slide to scrub, open to drop", Armed: "armed — twist to scrub", Adjusting: "scrubbing",
  TrackingLost: "tracking lost — let go to re-engage", Cancelled: "cancelled — let go to re-engage" };

/** @param {{text: string, until: number} | null} flash */
export function drawOverlay(canvas, hand, v, now, flash) {
  const w = canvas.width, h = canvas.height, g = canvas.getContext("2d");
  g.clearRect(0, 0, w, h);
  const color = COLORS[v.state] ?? "#bbb";
  g.font = "600 16px system-ui, sans-serif";
  g.lineCap = "round";
  if (flash && now < flash.until) {
    g.fillStyle = "rgba(60,200,255,0.85)";
    g.font = "700 64px system-ui, sans-serif";
    g.textAlign = "center";
    g.fillText(flash.text, w / 2, 80);
    g.font = "600 16px system-ui, sans-serif";
  }
  if (!hand) {
    if (v.state === "TrackingLost" || v.state === "Cancelled") {
      g.fillStyle = color; g.textAlign = "center"; g.fillText(LABELS[v.state], w / 2, h - 20);
    }
    return;
  }
  const P = hand.image.map((p) => ({ x: (1 - p.x) * w, y: p.y * h }));
  // Skeleton
  g.strokeStyle = color; g.lineWidth = 3;
  for (const [a, b] of BONES) { g.beginPath(); g.moveTo(P[a].x, P[a].y); g.lineTo(P[b].x, P[b].y); g.stroke(); }
  g.fillStyle = "#fff";
  for (const p of P) { g.beginPath(); g.arc(p.x, p.y, 3, 0, 7); g.fill(); }
  // Palm centre and size in pixels
  const cx = (P[0].x + P[5].x + P[9].x + P[17].x) / 4, cy = (P[0].y + P[5].y + P[9].y + P[17].y) / 4;
  const R = Math.max(50, Math.hypot(P[9].x - P[0].x, P[9].y - P[0].y) * 1.2);
  const engaged = v.state === "Armed" || v.state === "Adjusting";

  if (!engaged && v.blade) {
    // Chop-ready: a blade line along the hand, pointing down.
    g.strokeStyle = "#f5c"; g.lineWidth = 4; g.setLineDash([10, 6]);
    g.beginPath(); g.moveTo(cx, cy - R); g.lineTo(cx, cy + R * 1.6); g.stroke(); g.setLineDash([]);
    g.fillStyle = "#f5c"; g.textAlign = "center"; g.fillText("chop down to cut", cx, cy + R * 1.6 + 20);
  }
  if (!engaged && v.tapping) {
    g.fillStyle = "#fc3"; g.beginPath(); g.arc(P[4].x, P[4].y, 10, 0, 7); g.fill();
  }
  if (!engaged) {
    // 🤘 meter: ring fills a quarter per finger in place (index + pinky up, middle + ring down).
    const fill = Number.isFinite(v.hornsFingers) ? Math.max(0, Math.min(1, v.hornsFingers / 4)) : 0;
    g.strokeStyle = "rgba(255,255,255,0.25)"; g.lineWidth = 8;
    g.beginPath(); g.arc(cx, cy, R * 0.6, 0, 7); g.stroke();
    g.strokeStyle = v.horns ? "#2c9" : "rgba(255,255,255,0.85)";
    g.beginPath(); g.arc(cx, cy, R * 0.6, -Math.PI / 2, -Math.PI / 2 + fill * 2 * Math.PI); g.stroke();
  } else {
    // Twist dial: 0° at top; dead zone grey; speed bands brighter outward; needle = current twist.
    const rad = (deg) => -Math.PI / 2 + (deg * Math.PI) / 180;
    const arc = (a0, a1, style, width) => { g.strokeStyle = style; g.lineWidth = width; g.beginPath(); g.arc(cx, cy, R, rad(a0), rad(a1)); g.stroke(); };
    arc(-C.deadZoneDeg, C.deadZoneDeg, "rgba(255,255,255,0.35)", 10);
    const n = C.rates.length, span = (C.maxDeg - C.deadZoneDeg) / n;
    g.textAlign = "center"; g.font = "600 12px system-ui, sans-serif";
    for (let k = 0; k < n; k++) {
      const a0 = C.deadZoneDeg + k * span, a1 = k === n - 1 ? C.maxDeg + 30 : a0 + span;
      const style = `rgba(60,200,255,${0.25 + 0.6 * (k / Math.max(1, n - 1))})`;
      for (const s of [1, -1]) {
        arc(s > 0 ? a0 : -a1, s > 0 ? a1 : -a0, style, 10);
        if (!v.fine) {
          const m = rad(s * (a0 + Math.min(span, a1 - a0) / 2));
          g.fillStyle = "#fff";
          g.fillText(`${s > 0 ? "" : "−"}${C.rates[k]}×`, cx + Math.cos(m) * (R + 26), cy + Math.sin(m) * (R + 26) + 4);
        }
      }
    }
    if (v.fine) { // detent ticks
      g.strokeStyle = "#fff"; g.lineWidth = 2;
      for (let d = C.deadZoneDeg; d <= C.maxDeg + 30; d += C.fineDetentDeg) for (const s of [1, -1]) {
        const m = rad(s * d);
        g.beginPath(); g.moveTo(cx + Math.cos(m) * (R - 9), cy + Math.sin(m) * (R - 9)); g.lineTo(cx + Math.cos(m) * (R + 9), cy + Math.sin(m) * (R + 9)); g.stroke();
      }
    }
    const a = rad(Math.max(-130, Math.min(130, v.angleDeg)));
    g.strokeStyle = color; g.lineWidth = 4;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * (R + 12), cy + Math.sin(a) * (R + 12)); g.stroke();
    g.fillStyle = color; g.beginPath(); g.arc(cx, cy, 6, 0, 7); g.fill();
    g.font = "700 20px system-ui, sans-serif"; g.fillStyle = "#fff";
    g.fillText(v.fine ? "fine" : `${v.rate}×`, cx, cy + R + 36);
  }
  // State label above the hand
  const top = Math.min(...P.map((p) => p.y));
  g.textAlign = "center"; g.font = "600 16px system-ui, sans-serif";
  const label = LABELS[v.state] ?? v.state;
  const tw = g.measureText(label).width + 16;
  g.fillStyle = "rgba(0,0,0,0.6)"; g.fillRect(cx - tw / 2, top - 40, tw, 26);
  g.fillStyle = color; g.fillText(label, cx, top - 21);
}
