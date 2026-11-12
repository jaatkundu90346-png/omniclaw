// Generate the ad's voiceover with the Windows built-in speech synth (SAPI),
// then measure every line with ffprobe so the composition can place the audio
// AND the captions exactly on the beat.
//
// No API key, no network, no third-party voice — Microsoft David/Zira are
// installed with Windows. The output is plain WAV under
// marketing/video/public/vo/ plus a manifest with the timings.
//
// Usage: node scripts/make-voiceover.mjs
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "marketing", "video", "public", "vo");
const VOICE = process.env.OC_VOICE || "Microsoft David Desktop";
const RATE = Number(process.env.OC_VOICE_RATE ?? 2); // SAPI rate: -10..10
const VOLUME = Number(process.env.OC_VOICE_VOLUME ?? 100);

// The script. Each line is placed at a scene cue (see CUES) and the audio is
// rendered per line, so a caption and its audio can never drift apart.
const LINES = [
  { id: "hook", cue: 600, text: "Your AI agent shouldn't live in someone else's cloud." },
  { id: "problem", cue: 4300, text: "Your code on their server. Your keys in their vault." },
  { id: "tab", cue: 7600, text: "That's not an agent. That's a tab." },
  { id: "product", cue: 10000, text: "Meet OmniClaw. A local-first AI agent platform for Windows." },
  { id: "tools", cue: 16300, text: "Two hundred tools, all running on your own machine." },
  { id: "task", cue: 21800, text: "Give it a task. It plans, it calls tools, it shows every step." },
  { id: "built", cue: 27300, text: "Then it builds the thing, and you watch it live." },
  { id: "report", cue: 32800, text: "And it tells you exactly what it made." },
  { id: "cta", cue: 37600, text: "OmniClaw. Local-first. Yours. Windows." },
  { id: "cta2", cue: 42400, text: "Free download on GitHub." },
];

function findFfmpegTool(name) {
  const probe = spawnSync("where", [name], { encoding: "utf8", shell: true, windowsHide: true });
  if (probe.status === 0 && probe.stdout.trim()) return probe.stdout.split(/\r?\n/)[0].trim();
  return "";
}

const ffprobe = findFfmpegTool("ffprobe");

function probeDurationMs(file) {
  if (!ffprobe) return null;
  const r = spawnSync(ffprobe, [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file,
  ], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) return null;
  const sec = Number(String(r.stdout).trim());
  return Number.isFinite(sec) ? Math.round(sec * 1000) : null;
}

function speak(text, outFile) {
  const escaped = text.replace(/'/g, "''");
  const ps = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Speech; `
    + `$s=New-Object System.Speech.Synthesis.SpeechSynthesizer; `
    + `$s.SelectVoice('${VOICE.replace(/'/g, "''")}'); `
    + `$s.Rate=${RATE}; $s.Volume=${VOLUME}; `
    + `$s.SetOutputToWaveFile('${outFile.replace(/'/g, "''")}'); `
    + `$s.Speak('${escaped}'); $s.Dispose();`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    encoding: "utf8", windowsHide: true, timeout: 60000,
  });
  if (r.status !== 0) {
    throw new Error(`SAPI failed for "${text}": ${r.stderr || r.stdout}`);
  }
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const manifest = { voice: VOICE, rate: RATE, lines: [] };
let totalMs = 0;
let lastEnd = 0;

for (const [index, line] of LINES.entries()) {
  const file = `line-${String(index + 1).padStart(2, "0")}.wav`;
  const abs = path.join(OUT_DIR, file);
  console.log(`speaking ${line.id} ...`);
  speak(line.text, abs);
  const dur = probeDurationMs(abs);
  if (!dur) throw new Error("ffprobe is required to time the voiceover (install ffmpeg)");
  // Schedule: the scene cue is the IDEAL start, but a line can never start
  // before the previous one finished — two voices over each other is the
  // cheapest way to make an ad feel broken.
  const earliest = lastEnd + 200;
  const startMs = Math.max(line.cue, earliest);
  const endMs = startMs + dur;
  lastEnd = endMs;
  totalMs = Math.max(totalMs, endMs);
  manifest.lines.push({ id: line.id, file, text: line.text, startMs, endMs, durationMs: dur });
  console.log(`  ok ${file} ${dur}ms  ->  ${(startMs / 1000).toFixed(1)}s .. ${(endMs / 1000).toFixed(1)}s${startMs > line.cue ? " (pushed)" : ""}`);
}

fs.writeFileSync(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
// Also written into src/ so the composition can import the timings (a JSON
// import is bundled; the public/ copy is for anyone inspecting the output).
const srcDir = path.join(ROOT, "marketing", "video", "src");
fs.mkdirSync(srcDir, { recursive: true });
fs.writeFileSync(path.join(srcDir, "voiceover.json"), JSON.stringify(manifest, null, 2));
console.log(`\nvoiceover: ${manifest.lines.length} lines, ${(totalMs / 1000).toFixed(1)}s of speech`);
console.log(`wrote ${path.join(OUT_DIR, "manifest.json")}`);
console.log(`wrote ${path.join(srcDir, "voiceover.json")}`);
