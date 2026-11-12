// Generate the ad's music bed — a soft, minimal ambient loop written from
// scratch (no stock-music licensing, no download, no API key).
//
// It is deliberately QUIET: the voice is the message, the bed is the floor.
// A slow pad (A minor), a gentle arpeggio that breathes in and out, a soft
// sub pulse on the downbeat, and a wide noise swell — all under the voice.
//
// Usage: node scripts/make-music.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "marketing", "video", "public", "music");
const DURATION = Number(process.env.OC_MUSIC_SECONDS ?? 42);
const RATE = 32000; // enough for a pad, and a small file
const PEAK = Number(process.env.OC_MUSIC_PEAK ?? 0.16); // ~-16 dBFS

const N = Math.floor(DURATION * RATE);
const out = new Float32Array(N);

// Deterministic noise (so a re-run sounds identical).
let seed = 1337;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return (seed / 0xffffffff) * 2 - 1;
};

// A minor: A2 E3 C4 A4, with a slow swell.
const CHORD = [110.0, 164.81, 261.63, 440.0];
// The arpeggio notes (two octaves up, gentle).
const ARP = [440.0, 523.25, 659.25, 523.25, 392.0, 523.25, 659.25, 523.25];

for (let i = 0; i < N; i++) {
  const t = i / RATE;

  // Pad: each chord tone with its own slow tremolo, slightly detuned.
  let pad = 0;
  for (let v = 0; v < CHORD.length; v++) {
    const f = CHORD[v];
    const lfo = 0.55 + 0.45 * Math.sin(2 * Math.PI * (0.035 + v * 0.012) * t);
    const detune = 1 + (v - 1.5) * 0.0016;
    pad += Math.sin(2 * Math.PI * f * detune * t) * lfo * (0.5 / CHORD.length);
  }

  // Arpeggio: one note per second, fading in and out.
  const step = Math.floor(t) % ARP.length;
  const stepPhase = t - Math.floor(t);
  const env = Math.sin(Math.PI * Math.min(1, stepPhase / 0.85)) ** 1.6;
  const arp = Math.sin(2 * Math.PI * ARP[step] * t) * env * 0.11;

  // Sub pulse on every second, quick decay.
  const beatPhase = t - Math.floor(t);
  const kick = Math.sin(2 * Math.PI * (58 - 22 * beatPhase) * t) * Math.exp(-beatPhase * 9) * 0.5;

  // Wide noise swell, very quiet.
  const swell = (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.045 * t)) * 0.012;
  const air = rnd() * swell;

  out[i] = pad * 0.5 + arp + kick + air;
}

// Master: fade in / out, soft clip, normalize to the target peak.
const fadeIn = Math.floor(1.6 * RATE);
const fadeOut = Math.floor(2.2 * RATE);
let peak = 0;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(out[i]));
const gain = peak > 0 ? PEAK / peak : 1;
for (let i = 0; i < N; i++) {
  let g = gain;
  if (i < fadeIn) g *= i / fadeIn;
  if (i > N - fadeOut) g *= (N - i) / fadeOut;
  out[i] = Math.tanh(out[i] * g * 1.4) * 0.92;
}

// WAV (16-bit mono).
const dataBytes = N * 2;
const buf = Buffer.alloc(44 + dataBytes);
buf.write("RIFF", 0);
buf.writeUInt32LE(36 + dataBytes, 4);
buf.write("WAVE", 8);
buf.write("fmt ", 12);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20); // PCM
buf.writeUInt16LE(1, 22); // mono
buf.writeUInt32LE(RATE, 24);
buf.writeUInt32LE(RATE * 2, 28);
buf.writeUInt16LE(2, 32);
buf.writeUInt16LE(16, 34);
buf.write("data", 36);
buf.writeUInt32LE(dataBytes, 40);
for (let i = 0; i < N; i++) {
  buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(out[i] * 32767))), 44 + i * 2);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const file = path.join(OUT_DIR, "bed.wav");
fs.writeFileSync(file, buf);
console.log(`ok: wrote ${file} (${(buf.length / 1024 / 1024).toFixed(2)} MB, ${DURATION}s @ ${RATE} Hz mono, peak ${PEAK})`);
