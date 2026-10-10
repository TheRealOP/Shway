// Browser-only microphone pieces shared by voice.html and ../demo.html.

/** Opens the microphone. Resolves to {stream} or {error: message for the user}. Never throws. */
export async function openMic() {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    return { error: "This browser has no getUserMedia/MediaRecorder (or the page is not on localhost/https)." };
  }
  try {
    return { stream: await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }) };
  } catch (e) {
    const denied = e.name === "NotAllowedError" || e.name === "SecurityError";
    return { error: denied
      ? `Microphone permission denied (${e.name}). Allow microphone access for this page and reload.`
      : `Microphone unavailable: ${e.name}: ${e.message}` };
  }
}

/**
 * Turns createVoice() events into recordings: one MediaRecorder per utterance, started only on an
 * explicit push-to-talk start. Returns handle(event) → the event's notice text, or "".
 * @param {ReturnType<import("./utterance.mjs").createVoice>} voice
 * @param {{stream: () => MediaStream | null, onUtterance: (u: any) => void}} opts
 */
export function createCapture(voice, { stream, onUtterance }) {
  let recorder = null;
  return (e) => {
    if (!e) return "";
    if (e.type === "recording") {
      const s = stream();
      if (!s) { voice.cancel(performance.now()); return "No microphone: nothing is recorded."; }
      const chunks = [];
      const r = new MediaRecorder(s);
      r.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
      r.onstop = () => {
        const done = r.result; // set by the stop/cancel below
        if (done?.type !== "utterance") return; // rejected or cancelled: audio is discarded
        done.utterance.audio = new Blob(chunks, { type: r.mimeType });
        onUtterance(done.utterance);
      };
      r.start();
      recorder = r;
      return "";
    }
    // Only an event that ended the recording stops the recorder (a rejected double start must not).
    if (recorder && !voice.view().recording) { recorder.result = e; if (recorder.state !== "inactive") recorder.stop(); recorder = null; }
    if (e.type === "rejected") return `Not kept: ${e.reason}`;
    if (e.type === "cancelled") return `Cancelled ${e.id}`;
    return "";
  };
}
