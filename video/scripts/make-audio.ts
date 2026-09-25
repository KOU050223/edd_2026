// 120 BPM の BGM と効果音を合成し、public/soundtrack.wav へ 1 本にミックスして書き出す。
// 外部の音源素材は使わない（ライセンスの確認が要らず、毎回同じ波形が出る）。
// 拍と効果音の位置は src/timeline.ts から読むので、映像と音はここでずれない。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BAR,
  BEAT,
  DURATION,
  FPS,
  NARRATION,
  SFX,
  barOf,
  narrationFrame,
  type Sfx,
} from "../src/timeline.ts";
import type { VoiceClip } from "./make-voice.ts";

const SR = 44_100;
const LENGTH = Math.round((DURATION / FPS) * SR);
const L = new Float32Array(LENGTH);
const R = new Float32Array(LENGTH);

const sec = (frame: number) => frame / FPS;
const idx = (t: number) => Math.round(t * SR);
const midi = (n: number) => 440 * 2 ** ((n - 69) / 12);

// 乱数は種を固定する。書き出すたびに波形が変わるとレビューで差分が追えない。
let seed = 0x1234abcd;
const noise = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return ((seed >>> 0) / 0xffffffff) * 2 - 1;
};

function add(start: number, buf: Float32Array, gain: number, pan = 0) {
  const s = idx(start);
  const gl = gain * Math.min(1, 1 - pan);
  const gr = gain * Math.min(1, 1 + pan);
  for (let i = 0; i < buf.length; i++) {
    const j = s + i;
    if (j < 0 || j >= LENGTH) continue;
    L[j] += buf[i] * gl;
    R[j] += buf[i] * gr;
  }
}

/** Chamberlin の状態変数フィルタ。cutoff は各サンプルで変えられる。 */
function svf(
  input: Float32Array,
  cutoff: (i: number) => number,
  q: number,
  mode: "lp" | "bp" | "hp",
) {
  const out = new Float32Array(input.length);
  let low = 0;
  let band = 0;
  for (let i = 0; i < input.length; i++) {
    const f = 2 * Math.sin((Math.PI * Math.min(cutoff(i), SR / 6)) / SR);
    low += f * band;
    const high = input[i] - low - q * band;
    band += f * high;
    out[i] = mode === "lp" ? low : mode === "bp" ? band : high;
  }
  return out;
}

const env = (t: number, attack: number, decay: number) =>
  t < attack ? t / attack : Math.exp(-(t - attack) / decay);

// ---------------- 楽器 ----------------

function kick(gain = 1) {
  const n = idx(0.45);
  const b = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = 45 + 110 * Math.exp(-t / 0.04);
    ph += (2 * Math.PI * f) / SR;
    b[i] = Math.tanh(1.6 * Math.sin(ph)) * Math.exp(-t / 0.14) * gain;
  }
  return b;
}

function clap() {
  const n = idx(0.3);
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    // 手拍子らしさは、立ち上がりを 3 回刻むことで出す
    const burst = [0, 0.011, 0.022].reduce(
      (a, o) => a + (t >= o ? Math.exp(-(t - o) / 0.008) : 0),
      0,
    );
    raw[i] = noise() * (burst * 0.5 + Math.exp(-t / 0.09));
  }
  return svf(raw, () => 1400, 0.8, "bp");
}

function hat(open = false) {
  const n = idx(open ? 0.22 : 0.06);
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) raw[i] = noise() * Math.exp(-i / SR / (open ? 0.08 : 0.018));
  return svf(raw, () => 7000, 0.6, "hp");
}

function bass(note: number, dur: number) {
  const n = idx(dur);
  const b = new Float32Array(n);
  const f = midi(note);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const s = Math.sin(2 * Math.PI * f * t) + 0.35 * Math.sin(4 * Math.PI * f * t);
    b[i] = Math.tanh(1.3 * s) * env(t, 0.005, dur * 0.6) * Math.min(1, (dur - t) / 0.01);
  }
  return b;
}

function pad(notes: number[], dur: number) {
  const n = idx(dur + 0.6);
  const raw = new Float32Array(n);
  for (const note of notes) {
    for (const detune of [-0.08, 0.08]) {
      const f = midi(note + detune);
      for (let i = 0; i < n; i++) {
        const saw = 2 * ((f * i) / SR - Math.floor(0.5 + (f * i) / SR));
        raw[i] += saw * 0.18;
      }
    }
  }
  const out = svf(raw, (i) => 900 + 500 * Math.sin((2 * Math.PI * i) / SR / 4), 0.9, "lp");
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const a = Math.min(1, t / 0.25);
    const r = t > dur ? Math.max(0, 1 - (t - dur) / 0.6) : 1;
    out[i] *= a * r;
  }
  return out;
}

function pluck(note: number) {
  const n = idx(0.35);
  const b = new Float32Array(n);
  const f = midi(note);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const tri = (2 / Math.PI) * Math.asin(Math.sin(2 * Math.PI * f * t));
    b[i] = tri * Math.exp(-t / 0.09);
  }
  return b;
}

// ---------------- 効果音 ----------------

function sfx(e: Sfx): Float32Array {
  const p = e.pitch ?? 0;
  switch (e.kind) {
    case "click": {
      const n = idx(0.06);
      const b = new Float32Array(n);
      const f = 1800 * 2 ** (p / 12);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        b[i] =
          (Math.sin(2 * Math.PI * f * t) * 0.6 + noise() * Math.exp(-t / 0.002)) *
          Math.exp(-t / 0.012);
      }
      return b;
    }
    case "tick": {
      const n = idx(0.03);
      const b = new Float32Array(n);
      for (let i = 0; i < n; i++)
        b[i] = Math.sin(2 * Math.PI * 3200 * (i / SR)) * Math.exp(-i / SR / 0.006);
      return b;
    }
    case "pop": {
      const n = idx(0.12);
      const b = new Float32Array(n);
      let ph = 0;
      const base = 520 * 2 ** (p / 12);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        ph += (2 * Math.PI * base * (1 + 0.8 * Math.exp(-t / 0.015))) / SR;
        b[i] = Math.sin(ph) * env(t, 0.002, 0.035);
      }
      return b;
    }
    case "chime": {
      const n = idx(1.2);
      const b = new Float32Array(n);
      const f = midi(84 + p);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        b[i] =
          (Math.sin(2 * Math.PI * f * t) +
            0.4 * Math.sin(2 * Math.PI * f * 2.76 * t) * Math.exp(-t / 0.15) +
            0.2 * Math.sin(2 * Math.PI * f * 5.4 * t) * Math.exp(-t / 0.06)) *
          env(t, 0.002, 0.35) *
          0.35;
      }
      return b;
    }
    case "whoosh": {
      const n = idx(0.5);
      const raw = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        raw[i] = noise() * Math.sin((Math.PI * t) / 0.5) ** 2;
      }
      return svf(raw, (i) => 400 + 5000 * Math.sin((Math.PI * i) / n), 0.5, "bp");
    }
    case "riser": {
      const len = sec(e.length ?? BAR);
      const n = idx(len);
      const raw = new Float32Array(n);
      for (let i = 0; i < n; i++) raw[i] = noise() * (i / n) ** 2;
      const out = svf(raw, (i) => 300 + 7000 * (i / n) ** 2, 0.4, "bp");
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        out[i] +=
          Math.sin(2 * Math.PI * (200 * t + (600 * t * t) / (2 * len))) * 0.15 * (i / n) ** 2;
      }
      return out;
    }
    case "hit": {
      const n = idx(2.2);
      const b = new Float32Array(n);
      const k = kick(1.2);
      for (let i = 0; i < k.length; i++) b[i] += k[i];
      const crash = new Float32Array(n);
      for (let i = 0; i < n; i++) crash[i] = noise() * Math.exp(-i / SR / 0.7);
      const hp = svf(crash, () => 5000, 0.7, "hp");
      for (let i = 0; i < n; i++) b[i] += hp[i] * 0.5;
      return b;
    }
  }
}

// ---------------- 譜面 ----------------

// 1 小節ずつのコード（MIDI ノート）。場面の小節位置から組み立てるので、
// timeline.ts で尺を変えても譜面が追従する。
const Am = [57, 60, 64, 69];
const F = [53, 60, 65, 69];
const G = [55, 59, 62, 67];
const Em = [52, 59, 64, 67];
const C = [48, 55, 60, 64, 67];

const TOTAL_BARS = DURATION / BAR;
const LOGO_BAR = barOf("logo");
const DRUMS_FROM = barOf("vscode"); // VS Code の場面からビートが入る
const FOUR_ON_FLOOR_FROM = DRUMS_FROM + 2; // 最初の 2 小節は 1・3 拍だけで軽く
const CLAP_FROM = barOf("desktop");
const ARP_FROM = barOf("everywhere");
const SIXTEENTH_HATS_FROM = barOf("history");

const CYCLE = [F, G, Em, Am];
const CHORDS = Array.from({ length: TOTAL_BARS }, (_, b) => {
  if (b < DRUMS_FROM) return [Am, F, G][b % 3];
  if (b >= LOGO_BAR) return C;
  // ロゴの直前は G に置き、C への解決を強くする
  if (b === LOGO_BAR - 1) return G;
  return CYCLE[(b - DRUMS_FROM) % CYCLE.length];
});

const barStart = (b: number) => sec(b * BAR);
const beatSec = sec(BEAT);

for (let b = 0; b < CHORDS.length; b++) {
  const chord = CHORDS[b];
  const t0 = barStart(b);
  const root = chord[0] - 12;

  if (b === LOGO_BAR) {
    // ロゴの間は C を伸ばし、動画の終わりへ向けて減衰させる
    add(t0, pad(chord, sec(BAR * (TOTAL_BARS - LOGO_BAR)) - 0.6), 0.55, -0.1);
    add(t0, bass(root, sec(BAR * 2)), 0.35);
    // ロゴの後ろで鳴らす分散和音。2 小節ぶん上り下りする
    [60, 64, 67, 72, 76, 79, 76, 72, 67, 64, 67, 72].forEach((n, i) =>
      add(t0 + 0.25 + i * (beatSec / 2), pluck(n + 12), 0.1, i % 2 ? 0.3 : -0.3),
    );
    continue;
  }
  if (b > LOGO_BAR) continue;

  add(t0, pad(chord, sec(BAR) - 0.05), b < DRUMS_FROM ? 0.45 : 0.35);
  if (b < DRUMS_FROM) continue;

  for (let i = 0; i < 8; i++) {
    const note = i % 2 === 1 ? root + 12 : root;
    add(t0 + i * (beatSec / 2), bass(note, beatSec / 2 - 0.02), 0.32);
  }
  const fill = b === LOGO_BAR - 1;
  for (let beat = 0; beat < 4; beat++) {
    const tb = t0 + beat * beatSec;
    if (b >= FOUR_ON_FLOOR_FROM || beat % 2 === 0) add(tb, kick(), 0.8);
    add(tb + beatSec / 2, hat(beat === 3), 0.22, 0.3);
    if (b >= SIXTEENTH_HATS_FROM) {
      add(tb + beatSec / 4, hat(), 0.1, -0.3);
      add(tb + (3 * beatSec) / 4, hat(), 0.1, -0.3);
    }
    if (fill && beat >= 2) {
      // ロゴへ入る前の 2 拍は手拍子を 16 分で刻んで盛り上げる
      for (let k = 0; k < 4; k++)
        add(tb + (k * beatSec) / 4, clap(), 0.18 + 0.1 * (beat - 2) + 0.02 * k);
    } else if (b >= CLAP_FROM && (beat === 1 || beat === 3)) {
      add(tb, clap(), 0.35);
    }
  }
  if (b >= ARP_FROM) {
    const tones = [...chord.slice(1), chord[1] + 12];
    for (let i = 0; i < 16; i++) {
      add(t0 + i * (beatSec / 4), pluck(tones[i % tones.length] + 12), 0.12, i % 2 ? 0.4 : -0.4);
    }
  }
}

for (const e of SFX) add(sec(e.frame), sfx(e), 0.6 * (e.gain ?? 1));

// ---------------- ナレーション ----------------

// scripts/make-voice.ts が書いた一覧を読む。無ければ黙って無音で進めず、失敗にする
const VOICE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../public/voice");
const manifestPath = join(VOICE_DIR, "manifest.json");
if (!existsSync(manifestPath)) {
  throw new Error(
    "public/voice/manifest.json が無い。先に `npm run voice` でナレーションを作ること",
  );
}
const clips = JSON.parse(readFileSync(manifestPath, "utf8")) as VoiceClip[];

// 原稿を変えたのに音声を作り直していなければ、古い読み上げが混ざる
const expected = NARRATION.map((n) => `${narrationFrame(n)}:${n.text}`).join("\n");
const actual = clips.map((c) => `${c.frame}:${c.text}`).join("\n");
if (expected !== actual) {
  throw new Error(
    "ナレーションの一覧が原稿（timeline.ts の NARRATION）と一致しない。`npm run voice` を実行し直すこと",
  );
}

// 読み上げが次の行や動画の終わりへはみ出していないか。重なると 2 行が同時に聞こえる
const overflows = clips.flatMap((c, i) => {
  const limit = i + 1 < clips.length ? clips[i + 1].frame : DURATION;
  const end = c.frame + c.seconds * FPS;
  return end > limit ? [`「${c.text}」が ${((end - limit) / FPS).toFixed(2)} 秒はみ出す`] : [];
});
if (overflows.length > 0) {
  throw new Error(
    `ナレーションが収まらない:\n${overflows.join("\n")}\n開始位置か場面の尺を見直すこと`,
  );
}

/** 16bit モノラル WAV を読み、SR へ線形補間で変換する */
function loadVoice(file: string): Float32Array {
  const b = readFileSync(join(VOICE_DIR, file));
  const rate = b.readUInt32LE(24);
  const n = b.readUInt32LE(40) / 2;
  const out = new Float32Array(Math.floor((n * SR) / rate));
  for (let i = 0; i < out.length; i++) {
    const x = (i * rate) / SR;
    const j = Math.floor(x);
    const a = b.readInt16LE(44 + j * 2) / 32768;
    const c = j + 1 < n ? b.readInt16LE(44 + (j + 1) * 2) / 32768 : a;
    out[i] = a + (c - a) * (x - j);
  }
  return out;
}

// 読み上げの間は BGM と効果音を下げる（-12dB 程度。声が下地より約 10dB 上に来る）。立ち上がりと戻りは滑らかにする
const DUCK = 0.25;
const duck = new Float32Array(LENGTH).fill(1);
for (const c of clips) {
  const from = idx(sec(c.frame) - 0.15);
  const to = idx(sec(c.frame) + c.seconds + 0.25);
  for (let i = Math.max(0, from); i < Math.min(LENGTH, to); i++) duck[i] = DUCK;
}
let smooth = 1;
const coef = 1 - Math.exp(-1 / (0.08 * SR));
for (let i = 0; i < LENGTH; i++) {
  smooth += (duck[i] - smooth) * coef;
  L[i] *= smooth;
  R[i] *= smooth;
}
for (const c of clips) add(sec(c.frame), loadVoice(c.file), 2.0);

// ---------------- 仕上げ ----------------

// 終わりの 1.2 秒で絞り切る。途中で切れた音にしない。
const fadeFrom = LENGTH - idx(1.2);
for (let i = fadeFrom; i < LENGTH; i++) {
  const g = 1 - (i - fadeFrom) / (LENGTH - fadeFrom);
  L[i] *= g;
  R[i] *= g;
}

let peak = 0;
for (let i = 0; i < LENGTH; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
if (peak === 0) throw new Error("合成結果が無音になった。譜面か SFX の定義を確認すること");
const norm = 0.89 / Math.tanh(peak * 0.9); // 軽く飽和させて -1 dBFS 付近へ

const data = Buffer.alloc(44 + LENGTH * 4);
data.write("RIFF", 0);
data.writeUInt32LE(36 + LENGTH * 4, 4);
data.write("WAVEfmt ", 8);
data.writeUInt32LE(16, 16);
data.writeUInt16LE(1, 20);
data.writeUInt16LE(2, 22);
data.writeUInt32LE(SR, 24);
data.writeUInt32LE(SR * 4, 28);
data.writeUInt16LE(4, 32);
data.writeUInt16LE(16, 34);
data.write("data", 36);
data.writeUInt32LE(LENGTH * 4, 40);
for (let i = 0; i < LENGTH; i++) {
  const l = Math.max(-1, Math.min(1, Math.tanh(L[i] * 0.9) * norm));
  const r = Math.max(-1, Math.min(1, Math.tanh(R[i] * 0.9) * norm));
  data.writeInt16LE(Math.round(l * 32767), 44 + i * 4);
  data.writeInt16LE(Math.round(r * 32767), 46 + i * 4);
}

const out = join(dirname(fileURLToPath(import.meta.url)), "../public/soundtrack.wav");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, data);
console.log(`wrote ${out} (${(LENGTH / SR).toFixed(2)}s, peak ${peak.toFixed(2)} → normalized)`);
