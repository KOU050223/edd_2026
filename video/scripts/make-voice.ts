// 読み上げ原稿（src/timeline.ts の NARRATION）を Gemini TTS で音声にし、
// public/voice/ に 1 行ずつ WAV で保存する。どの行をどのフレームで鳴らすかは
// public/voice/manifest.json に書き、scripts/make-audio.ts がそれを読んでミックスする。
//
// 生成済みの行は文面・声・モデルのハッシュで再利用する。API を叩くのは原稿を変えた行だけ。
//
//   GEMINI_API_KEY=... node scripts/make-voice.ts

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FPS, NARRATION, narrationFrame } from "../src/timeline.ts";

const MODEL = "gemini-3.8-flash-tts";
const VOICE = "Charon";
// 口調は声の選択だけで決める。文頭に英語で読み方を指示したところ、
// 指示文そのものまで読み上げる出力が混ざった（1 行あたり約 5 秒長くなった）。

// 送信先は固定する。設定や環境変数から変えられるようにしない（RULE-003 / RULE-006）。
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
// 単発の要求なので締め切りを設ける（RULE-001）。1 行の生成は通常 10 秒以内に返る。
const TIMEOUT_MS = 60_000;

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../public/voice");
const MANIFEST = join(OUT_DIR, "manifest.json");

export type VoiceClip = { frame: number; file: string; seconds: number; text: string };

const apiKey = process.env.GEMINI_API_KEY;

function wav(pcm: Buffer, rate: number): Buffer {
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

/** WAV の長さ（秒）。自分で書いた 44 バイトヘッダの PCM だけを想定する。 */
function wavSeconds(file: string): number {
  const b = readFileSync(file);
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 36, 40) !== "data") {
    throw new Error(`${file} は想定した WAV の形式ではない。削除して作り直すこと`);
  }
  return b.readUInt32LE(40) / b.readUInt32LE(28);
}

const MAX_ATTEMPTS = 5;

async function synthesize(text: string, attempt = 1): Promise<{ pcm: Buffer; rate: number }> {
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY が未設定。新しい原稿を音声にするには API キーが要る");
  }
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    // 資格情報を載せた要求なので、転送先へキーごと送らない（RULE-002）
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
      },
    }),
  });
  const body = await res.text();
  if (res.status === 429 && attempt < MAX_ATTEMPTS) {
    // 無料枠は 1 分あたりの回数が小さい。応答が示す秒数だけ待って同じ行をやり直す
    const wait = Number(/retry in ([\d.]+)s/.exec(body)?.[1] ?? 60) + 1;
    console.log(
      `  429（回数制限）。${wait.toFixed(0)} 秒待って再試行 ${attempt + 1}/${MAX_ATTEMPTS}`,
    );
    await new Promise((r) => setTimeout(r, wait * 1000));
    return synthesize(text, attempt + 1);
  }
  if (!res.ok) throw new Error(`TTS が ${res.status} を返した: ${body.slice(0, 500)}`);

  // 2xx でも中身が想定どおりでなければ失敗として扱う（RULE-004）
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (cause) {
    throw new Error(`TTS の応答が JSON ではない: ${body.slice(0, 200)}`, { cause });
  }
  const part = (
    json as {
      candidates?: {
        content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] };
      }[];
    }
  ).candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
  if (!part?.data || !part.mimeType) {
    throw new Error(`TTS の応答に音声が無い: ${body.slice(0, 500)}`);
  }
  const bytes = Buffer.from(part.data, "base64");
  // モデルの世代で返す形式が違う。3.8 は WAV、それより前は生の PCM（"audio/L16;codec=pcm;rate=24000"）
  if (part.mimeType.startsWith("audio/wav") || part.mimeType.startsWith("audio/x-wav")) {
    return parseWav(bytes);
  }
  const rate = Number(/rate=(\d+)/.exec(part.mimeType)?.[1]);
  if (!part.mimeType.startsWith("audio/L16") || !Number.isInteger(rate) || rate <= 0) {
    throw new Error(`想定外の音声形式: ${part.mimeType}`);
  }
  return { pcm: bytes, rate };
}

/** 16bit PCM の WAV から、モノラルの PCM を取り出す。それ以外の形式は失敗にする。 */
function parseWav(b: Buffer): { pcm: Buffer; rate: number } {
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("audio/wav と申告された応答が WAV ではない");
  }
  let fmt: { format: number; channels: number; rate: number; bits: number } | undefined;
  for (let at = 12; at + 8 <= b.length;) {
    const id = b.toString("ascii", at, at + 4);
    // ストリーミング由来の WAV はサイズ欄が 0xFFFFFFFF のことがある。そのときは末尾まで
    const size = Math.min(b.readUInt32LE(at + 4), b.length - at - 8);
    const body = at + 8;
    if (id === "fmt ") {
      fmt = {
        format: b.readUInt16LE(body),
        channels: b.readUInt16LE(body + 2),
        rate: b.readUInt32LE(body + 4),
        bits: b.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      if (!fmt) throw new Error("WAV の data が fmt より先に来た");
      if (fmt.format !== 1 || fmt.bits !== 16) {
        throw new Error(
          `16bit PCM 以外の WAV には対応していない（format=${fmt.format}, bits=${fmt.bits}）`,
        );
      }
      const data = b.subarray(body, body + size);
      if (fmt.channels === 1) return { pcm: Buffer.from(data), rate: fmt.rate };
      // 複数チャンネルなら左だけを使う（ナレーションは中央に置くので十分）
      const frames = Math.floor(data.length / (2 * fmt.channels));
      const mono = Buffer.alloc(frames * 2);
      for (let i = 0; i < frames; i++)
        mono.writeInt16LE(data.readInt16LE(i * 2 * fmt.channels), i * 2);
      return { pcm: mono, rate: fmt.rate };
    }
    at = body + size + (size % 2);
  }
  throw new Error("WAV に data チャンクが無い");
}

mkdirSync(OUT_DIR, { recursive: true });
const clips: VoiceClip[] = [];
for (const line of NARRATION) {
  const hash = createHash("sha256")
    .update(`${MODEL}\n${VOICE}\n${line.text}`)
    .digest("hex")
    .slice(0, 16);
  const file = `${hash}.wav`;
  const path = join(OUT_DIR, file);
  if (existsSync(path)) {
    console.log(`再利用  ${line.text}`);
  } else {
    const { pcm, rate } = await synthesize(line.text);
    writeFileSync(path, wav(pcm, rate));
    console.log(`生成    ${line.text}`);
  }
  const seconds = wavSeconds(path);
  // 余計なものまで読み上げていないかの目安。日本語の読み上げは 1 秒に 4〜8 文字程度
  const charsPerSecond = [...line.text].length / seconds;
  if (charsPerSecond < 3) {
    throw new Error(
      `「${line.text}」の音声が ${seconds.toFixed(1)} 秒あり、文字数に対して長すぎる。` +
        `原稿以外も読み上げている疑いがあるので ${path} を確認すること`,
    );
  }
  clips.push({ frame: narrationFrame(line), file, seconds, text: line.text });
}

// 原稿から外れた古い音声は消す。残すとどれが使われているか分からなくなる
const used = new Set(clips.map((c) => c.file));
for (const f of readdirSync(OUT_DIR)) {
  if (f.endsWith(".wav") && !used.has(f)) rmSync(join(OUT_DIR, f));
}
writeFileSync(MANIFEST, JSON.stringify(clips, null, 2) + "\n");

for (const c of clips) {
  console.log(`${(c.frame / FPS).toFixed(2).padStart(6)}s  ${c.seconds.toFixed(2)}s  ${c.text}`);
}
