/* global chrome */

let audioContext = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (
    message?.target !== "local-system-offscreen-audio"
    || message.action !== "play-completion-chime"
  ) return undefined;

  playCompletionChime()
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  return true;
});

async function playCompletionChime() {
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextClass) throw new Error("Web Audio is unavailable");
  if (!audioContext || audioContext.state === "closed") audioContext = new AudioContextClass();
  if (audioContext.state === "suspended") await audioContext.resume();

  const start = audioContext.currentTime + 0.025;
  const tones = [
    { frequency: 659.25, offset: 0, duration: 0.18, gain: 0.075 },
    { frequency: 830.61, offset: 0.13, duration: 0.20, gain: 0.070 },
    { frequency: 1046.50, offset: 0.27, duration: 0.30, gain: 0.065 },
  ];

  for (const tone of tones) scheduleTone(tone, start);
}

function scheduleTone({ frequency, offset, duration, gain }, start) {
  const oscillator = audioContext.createOscillator();
  const envelope = audioContext.createGain();
  const overtone = audioContext.createOscillator();
  const overtoneEnvelope = audioContext.createGain();
  const toneStart = start + offset;
  const toneEnd = toneStart + duration;

  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequency, toneStart);
  envelope.gain.setValueAtTime(0.0001, toneStart);
  envelope.gain.exponentialRampToValueAtTime(gain, toneStart + 0.018);
  envelope.gain.exponentialRampToValueAtTime(0.0001, toneEnd);
  oscillator.connect(envelope).connect(audioContext.destination);

  overtone.type = "sine";
  overtone.frequency.setValueAtTime(frequency * 2, toneStart);
  overtoneEnvelope.gain.setValueAtTime(0.0001, toneStart);
  overtoneEnvelope.gain.exponentialRampToValueAtTime(gain * 0.16, toneStart + 0.012);
  overtoneEnvelope.gain.exponentialRampToValueAtTime(0.0001, toneEnd - 0.025);
  overtone.connect(overtoneEnvelope).connect(audioContext.destination);

  oscillator.start(toneStart);
  overtone.start(toneStart);
  oscillator.stop(toneEnd + 0.02);
  overtone.stop(toneEnd);
}
