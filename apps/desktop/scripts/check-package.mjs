// 配布物の検査（Issue #279 ステップ 7）。electron-builder の後に走らせる。
//
//   node scripts/check-package.mjs [distDir]
//
// distDir 既定は apps/desktop/dist。mac の .app（dist/mac・mac-arm64）と
// win の dist/win-unpacked を見つけて 1 個ずつ検査する。
//
// 検査するもの:
//   - app.asar に src/・*.test.*・*.map・node_modules/ が入っていないこと
//   - 必須のビルド成果物（main・preload・renderer・OFL・トレイアイコン）があること
//   - Electron Fuses が期待どおり（@electron/fuses で実行ファイルを読む）
//   - mac では codesign --verify --deep --strict
// どれか失敗したら内容を出して非 0 で終わる。
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { createRequire } from "node:module";

import asar from "@electron/asar";
import fuses from "@electron/fuses";

const { listPackage } = asar;
const { FuseV1Options, getCurrentFuseWire } = fuses;
// FuseState はパッケージの公開 export に出ていないので内部モジュールから取る。
const { FuseState } = createRequire(import.meta.url)("@electron/fuses/dist/constants.js");

const distDir = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, "..", "dist"));

const failures = [];
const notes = [];
const fail = (target, message) => failures.push(`${target}: ${message}`);
const note = (target, message) => notes.push(`  ${target}: ${message}`);

/** dist 以下のパッケージ対象を見つける。 */
function findTargets(root) {
  if (!existsSync(root)) return [];
  const targets = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    if (entry.name.startsWith("mac")) {
      const apps = readdirSync(dir, { withFileTypes: true }).filter(
        (e) => e.isDirectory() && e.name.endsWith(".app"),
      );
      for (const appDir of apps) {
        targets.push({
          name: `${entry.name}/${appDir.name}`,
          platform: "mac",
          appPath: path.join(dir, appDir.name),
          asarPath: path.join(dir, appDir.name, "Contents", "Resources", "app.asar"),
          executablePath: path.join(dir, appDir.name, "Contents", "MacOS"),
        });
      }
    } else if (entry.name === "win-unpacked") {
      targets.push({
        name: "win-unpacked",
        platform: "win",
        appPath: dir,
        asarPath: path.join(dir, "resources", "app.asar"),
        executablePath: dir,
      });
    }
  }
  return targets;
}

/** asar の中身に混ざっていてはいけないもの。 */
const FORBIDDEN = [
  { label: "src/", test: (entry) => entry.startsWith("/src/") },
  { label: "*.test.*", test: (entry) => /\.test\.[^/]+$/.test(entry) },
  { label: "*.map", test: (entry) => entry.endsWith(".map") },
  { label: "node_modules/", test: (entry) => entry.startsWith("/node_modules/") },
];

const REQUIRED = [
  "/out/main/index.js",
  "/out/preload/index.cjs",
  "/out/renderer/index.html",
  "/out/renderer/fonts/OFL.txt",
  "/out/main/assets/tray-icon.png",
  "/out/main/assets/tray-icon@2x.png",
];

/** 期待する Fuse 状態。 */
const EXPECTED_FUSES = [
  { key: FuseV1Options.RunAsNode, state: FuseState.DISABLE },
  { key: FuseV1Options.EnableNodeOptionsEnvironmentVariable, state: FuseState.DISABLE },
  { key: FuseV1Options.EnableNodeCliInspectArguments, state: FuseState.DISABLE },
  { key: FuseV1Options.GrantFileProtocolExtraPrivileges, state: FuseState.DISABLE },
  { key: FuseV1Options.EnableEmbeddedAsarIntegrityValidation, state: FuseState.ENABLE },
  { key: FuseV1Options.OnlyLoadAppFromAsar, state: FuseState.ENABLE },
];

function checkAsar(target) {
  if (!existsSync(target.asarPath)) {
    fail(target.name, `app.asar が見つかりません: ${target.asarPath}`);
    return;
  }
  const entries = listPackage(target.asarPath);
  for (const { label, test } of FORBIDDEN) {
    const hits = entries.filter(test);
    if (hits.length > 0) {
      fail(target.name, `asar に ${label} が含まれています: ${hits.slice(0, 5).join(", ")}`);
    }
  }
  for (const required of REQUIRED) {
    if (!entries.includes(required)) {
      fail(target.name, `asar に必須ファイル ${required} がありません`);
    }
  }
  note(target.name, `asar ${entries.length} 項目を検査`);
}

async function checkFuses(target) {
  // 実行ファイルのパスはプラットフォームで違う。
  // mac: <app>/Contents/MacOS/<name>、win: win-unpacked/<product>.exe。
  let binary;
  if (target.platform === "mac") {
    const [name] = readdirSync(target.executablePath);
    binary = path.join(target.executablePath, name);
  } else {
    const [exe] = readdirSync(target.executablePath).filter((f) => f.endsWith(".exe"));
    binary = exe === undefined ? undefined : path.join(target.executablePath, exe);
  }
  if (binary === undefined || !existsSync(binary)) {
    fail(target.name, `Electron 実行ファイルが見つかりません: ${target.executablePath}`);
    return;
  }
  const wire = await getCurrentFuseWire(binary);
  for (const { key, state } of EXPECTED_FUSES) {
    const actual = wire[key];
    if (actual !== state) {
      fail(
        target.name,
        `Fuse ${FuseV1Options[key]} が ${FuseState[state]} ではなく ${FuseState[actual]} です`,
      );
    }
  }
  note(target.name, "Fuses を検査");
}

function checkSignature(target) {
  if (target.platform !== "mac") return;
  try {
    execFileSync("codesign", ["--verify", "--deep", "--strict", target.appPath], {
      stdio: "pipe",
    });
    note(target.name, "codesign --verify --deep --strict 合格");
  } catch (error) {
    const stderr = error.stderr?.toString().trim() ?? String(error);
    fail(target.name, `codesign の検証に失敗しました: ${stderr}`);
  }
}

const targets = findTargets(distDir);
if (targets.length === 0) {
  fail(distDir, "検査対象のパッケージ（dist/mac*/**/*.app・dist/win-unpacked）がありません");
}
for (const target of targets) {
  checkAsar(target);
  await checkFuses(target);
  checkSignature(target);
}

for (const line of notes) console.log(line);
if (failures.length > 0) {
  console.error("\n配布物の検査に失敗しました:");
  for (const message of failures) console.error(`  ✗ ${message}`);
  process.exit(1);
}
console.log(`\nOK: ${targets.length} 個のパッケージを検査しました`);
