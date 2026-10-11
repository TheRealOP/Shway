# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = ["mediapipe==0.10.21", "opencv-contrib-python"]
# ///
"""Shway webcam worker (DEV-91): the default camera → MediaPipe Hand Landmarker → JSON lines on stdout.

    uv run shway/hands.py [camera index, default 0]

Started by `node shway/assistant.mjs --camera`, which feeds the lines to surface/gestures/recognizer.mjs.
One line per frame: {"t": ms, "hand": {"image": [{x,y,z}×21], "world": [{x,y,z}×21], "handedness", "score"} | null},
the same shape the browser's hands.mjs produced. About every 100 ms also {"preview": base64 JPEG}: a small
mirrored frame with the landmarks drawn, for the editor's camera tile. A missing camera or model prints one
{"error": ...} line and exits non-zero. The model (Apache-2.0) is downloaded once into ~/.cache/shway.
"""

import base64
import json
import os
import subprocess
import sys
import time
from pathlib import Path

MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
PREVIEW_W, PREVIEW_H, PREVIEW_EVERY_S = 240, 180, 0.1
BONES = [(0, 1), (1, 2), (2, 3), (3, 4), (0, 5), (5, 6), (6, 7), (7, 8), (5, 9), (9, 10), (10, 11), (11, 12),
         (9, 13), (13, 14), (14, 15), (15, 16), (13, 17), (17, 18), (18, 19), (19, 20), (0, 17)]


def emit(obj):
    print(json.dumps(obj, separators=(",", ":")), flush=True)


def fail(msg):
    emit({"error": msg})
    sys.exit(1)


def model_path():
    cache = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "shway"
    path = cache / "hand_landmarker.task"
    if not path.exists():
        cache.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".part")
        try:  # curl uses the system certificates; Python's own store is often missing on macOS
            subprocess.run(["curl", "-fsSL", "-o", str(tmp), MODEL_URL], check=True)
        except (OSError, subprocess.CalledProcessError) as e:
            fail(f"could not download the hand model: {e}")
        tmp.replace(path)
    return str(path)


def points(lms):
    return [{"x": round(p.x, 5), "y": round(p.y, 5), "z": round(p.z, 5)} for p in lms]


def preview(cv2, frame, hand):
    small = cv2.flip(cv2.resize(frame, (PREVIEW_W, PREVIEW_H)), 1)  # mirrored, like a selfie view
    if hand:
        pts = [(int((1 - p.x) * PREVIEW_W), int(p.y * PREVIEW_H)) for p in hand]
        for a, b in BONES:
            cv2.line(small, pts[a], pts[b], (80, 220, 60), 2)
        for p in pts:
            cv2.circle(small, p, 2, (255, 255, 255), -1)
    ok, jpg = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 70])
    if ok:
        emit({"preview": base64.b64encode(jpg.tobytes()).decode("ascii")})


def main():
    import cv2
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions, vision

    index = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 0
    cap = cv2.VideoCapture(index)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
    ok, frame = cap.read() if cap.isOpened() else (False, None)
    if not ok:
        fail(f"camera {index} unavailable (missing, busy, or camera permission denied for this terminal)")
    landmarker = vision.HandLandmarker.create_from_options(vision.HandLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=model_path()),
        running_mode=vision.RunningMode.VIDEO, num_hands=1))
    t0, last_ms, last_preview = time.monotonic(), -1, 0.0
    while True:
        ok, frame = cap.read()
        if not ok:
            fail(f"camera {index} stopped delivering frames")
        now = time.monotonic()
        ms = max(last_ms + 1, int((now - t0) * 1000))  # detect_for_video needs strictly increasing timestamps
        last_ms = ms
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        r = landmarker.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), ms)
        hand = None
        if r.hand_landmarks and r.hand_world_landmarks:
            top = r.handedness[0][0] if r.handedness and r.handedness[0] else None
            hand = {"image": points(r.hand_landmarks[0]), "world": points(r.hand_world_landmarks[0]),
                    "handedness": top.category_name if top else "", "score": round(top.score, 3) if top else 0}
        emit({"t": ms, "hand": hand})
        if now - last_preview >= PREVIEW_EVERY_S:
            last_preview = now
            preview(cv2, frame, r.hand_landmarks[0] if r.hand_landmarks else None)


if __name__ == "__main__":
    try:
        main()
    except (KeyboardInterrupt, BrokenPipeError):
        pass
