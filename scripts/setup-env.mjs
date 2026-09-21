#!/usr/bin/env node
// ローカル開発用の .dev.vars を雛形から用意する。
//
// 既存ファイルは絶対に上書きしない。手元で入れた本物の秘密値を、
// 雛形の空値で踏み潰すと原因のわかりにくい 401 になる。
//
// --check を付けると生成はせず、雛形のままの値が残っていないかだけを検査する。
// `task dev` の前段に挟んであるので、値を埋め忘れたまま起動したことに気づける。

import { copyFile, readFile } from "node:fs/promises";
import { argv, exit } from "node:process";

const repoRoot = new URL("..", import.meta.url);

// 雛形のままでは動かない値。ここに挙げた鍵が example と同じ値のままなら警告する。
// 値を持たない（空の）雛形も、埋めるまで動かないので対象にする。
const targets = [
  {
    example: "apps/api/.dev.vars.example",
    actual: "apps/api/.dev.vars",
    mustEdit: ["GEMINI_API_KEY"],
  },
  {
    example: "apps/web/.dev.vars.example",
    actual: "apps/web/.dev.vars",
    mustEdit: ["AUTH_CLIENT_SECRET"],
  },
];

/** `KEY=value` 形式を素朴に読む。.dev.vars は wrangler が同じ素朴さで読む。 */
const parseEnv = (text) => {
  const entries = new Map();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    entries.set(trimmed.slice(0, separator).trim(), trimmed.slice(separator + 1).trim());
  }
  return entries;
};

const readIfExists = async (path) => {
  try {
    return await readFile(new URL(path, repoRoot), "utf8");
  } catch (error) {
    // 「無い」だけを不在として扱う。権限エラーなどは握りつぶさず投げ直す。
    if (error.code === "ENOENT") return null;
    throw error;
  }
};

const checkOnly = argv.includes("--check");

let missingFile = false;
const needsEdit = [];

for (const target of targets) {
  const existing = await readIfExists(target.actual);

  if (existing === null) {
    if (checkOnly) {
      console.error(`missing: ${target.actual} が無い。'task env' で作る。`);
      missingFile = true;
      continue;
    }
    await copyFile(new URL(target.example, repoRoot), new URL(target.actual, repoRoot));
    console.log(`created: ${target.actual} (${target.example} から)`);
  } else if (!checkOnly) {
    console.log(`kept:    ${target.actual} は既にある。上書きしない。`);
  }

  const current = parseEnv(existing ?? (await readFile(new URL(target.actual, repoRoot), "utf8")));
  const template = parseEnv(await readFile(new URL(target.example, repoRoot), "utf8"));

  for (const key of target.mustEdit) {
    const value = current.get(key);
    if (value === undefined || value === "" || value === template.get(key)) {
      needsEdit.push(`${target.actual}: ${key}`);
    }
  }
}

if (missingFile) exit(1);

if (needsEdit.length > 0) {
  const heading = checkOnly
    ? "以下の値が雛形のままで、実際の呼び出しは失敗する:"
    : "以下の値は雛形のままなので、使う前に埋めること:";
  console.error(`\n${heading}`);
  for (const item of needsEdit) console.error(`  - ${item}`);
  console.error("\n取得先は docs/auth.md と apps/api/README.md にある。");
  // --check は検査なので落とす。生成時は「作ったが未記入」を伝えるだけで止めない
  // （AI を使わない画面の開発は、鍵が空でも進められる）。
  if (checkOnly) exit(1);
}

if (checkOnly && needsEdit.length === 0) {
  console.log("ok: .dev.vars は埋まっている");
}
