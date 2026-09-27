import type { Sound } from './homeAiState.js';

const MUTE_KEY = 'pixelOffice.muted';
const CLACK_MIN_GAP_MS = 120;
let audio: AudioContext | null = null;
let lastClack = 0;
let muted = false;
try {
  muted = localStorage.getItem(MUTE_KEY) === '1';
} catch {
  // storage unavailable: use in-memory mute state
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(value: boolean): void {
  muted = value;
  try {
    localStorage.setItem(MUTE_KEY, value ? '1' : '0');
  } catch {
    // storage unavailable: mute lasts for this page only
  }
}

function context(): AudioContext | null {
  if (!audio) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    audio = new Ctor();
  }
  if (audio.state === 'suspended') void audio.resume();
  return audio;
}

function tone(
  a: AudioContext,
  freq: number,
  start: number,
  dur: number,
  type: OscillatorType,
  gain: number,
): void {
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(gain, start);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(g).connect(a.destination);
  osc.start(start);
  osc.stop(start + dur);
}

export function playSound(sound: Sound): void {
  if (isMuted()) return;
  const a = context();
  if (!a) return;
  const t = a.currentTime;
  if (sound === 'clack') {
    const nowMs = performance.now();
    if (nowMs - lastClack < CLACK_MIN_GAP_MS) return;
    lastClack = nowMs;
    tone(a, 1800 + Math.random() * 400, t, 0.025, 'square', 0.02);
  } else if (sound === 'ding') {
    tone(a, 880, t, 0.18, 'sine', 0.08);
    tone(a, 1320, t + 0.12, 0.25, 'sine', 0.07);
  } else {
    for (let i = 0; i < 4; i++) tone(a, i % 2 ? 660 : 440, t + i * 0.4, 0.38, 'sawtooth', 0.05);
  }
}
