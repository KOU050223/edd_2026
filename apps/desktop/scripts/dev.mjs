// 開発用の起動スクリプト。
// renderer は Vite dev server（HMR）から読み、main と preload は
// `vite build --watch` で再ビルドする。再ビルドが終わるたびに Electron を
// 再起動する（main / preload に HMR は効かないため）。
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import electronBinary from "electron";
import { build, createServer } from "vite";

const ROOT = path.resolve(import.meta.dirname, "..");
// 2 つの watcher が続けて BUNDLE_END を出しても再起動が重ならないようまとめる。
const RESTART_DEBOUNCE_MS = 300;

let rendererUrl;
let electronProcess;
let server;
const watchers = [];
let restarting = false;
let restartTimer;
let shutdownStarted = false;

function startElectron() {
  electronProcess = spawn(electronBinary, ["."], {
    cwd: ROOT,
    env: { ...process.env, ELECTRON_RENDERER_URL: rendererUrl },
    stdio: "inherit",
  });
  electronProcess.once("exit", (code) => {
    electronProcess = undefined;
    // 再起動のための kill では終了コードを引き継がない。
    if (!restarting) shutdown(code ?? 0);
  });
}

function restartElectron() {
  restarting = true;
  const current = electronProcess;
  const relaunch = () => {
    restarting = false;
    startElectron();
  };
  if (current) {
    current.once("exit", relaunch);
    current.kill();
  } else {
    relaunch();
  }
}

function scheduleRestart() {
  if (!electronProcess || shutdownStarted) return;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(restartElectron, RESTART_DEBOUNCE_MS);
}

// watcher の最初の BUNDLE_END まで待つ Promise を返す。
// 以後の BUNDLE_END では Electron の再起動を予約し、ERROR は握りつぶさず出す。
function watchRebuilds(watcher, name) {
  return new Promise((resolve, reject) => {
    watcher.on("event", (event) => {
      if (event.code === "BUNDLE_END") {
        event.result?.close();
        scheduleRestart();
        resolve();
        return;
      }
      if (event.code === "ERROR") {
        console.error(`${name} のビルドに失敗しました`, event.error);
        reject(event.error instanceof Error ? event.error : new Error(String(event.error)));
      }
    });
  });
}

async function shutdown(code) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  clearTimeout(restartTimer);
  electronProcess?.kill();
  await Promise.allSettled([...watchers.map((watcher) => watcher.close()), server?.close()]);
  process.exit(code);
}

async function main() {
  server = await createServer({
    configFile: path.join(ROOT, "vite.renderer.config.ts"),
  });
  await server.listen();
  rendererUrl = server.resolvedUrls?.local?.[0];
  if (!rendererUrl) {
    throw new Error("renderer の dev server URL を取得できませんでした。");
  }
  console.log(`renderer dev server: ${rendererUrl}`);

  const initialBuilds = await Promise.all(
    [
      ["vite.main.config.ts", "main"],
      ["vite.preload.config.ts", "preload"],
    ].map(async ([configFile, name]) => {
      const watcher = await build({
        configFile: path.join(ROOT, configFile),
        build: { watch: {} },
      });
      watchers.push(watcher);
      return watchRebuilds(watcher, name);
    }),
  );
  // main と preload の初回ビルドが揃ってから Electron を起動する。
  await Promise.all(initialBuilds);
  startElectron();
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

main().catch(async (error) => {
  console.error("開発サーバーの起動に失敗しました", error);
  await shutdown(1);
});
