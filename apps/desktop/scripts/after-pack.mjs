// electron-builder の afterPack フック。
// 署名 identity が無い環境（CI の mac ランナーなど）では electron-builder が署名を
// 丸ごとスキップし、Electron バイナリのリンカ adhoc 署名だけが残る。その状態で
// 配布するとバンドル署名が不完全（code has no resources but signature indicates
// they must be present）と判定され、quarantine 経由の起動は Gatekeeper に
// 「壊れている」と握られてしまう（Issue #211）。
// identity が無いときだけバンドル全体を adhoc 署名しておき、不完全な署名ではなく
// 「未公証の adhoc 署名」という状態にする。CSC_LINK / CSC_NAME がある環境では
// このあと electron-builder が正式署名で上書くので何もしない。
//
// なお package.json の electronFuses では resetAdHocDarwinSignature を有効にしている。
// Fuse の反転は署名済みの Electron Framework バイナリを書き換えてシールを壊すので、
// 反転直後に adhoc シールを付け直させないと `codesign --verify --deep --strict` が
// 失敗する（#211 の再発）。正式署名はそのあとの electron-builder の署名で上書く。
import { execFileSync } from "node:child_process";

export default function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;
  const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
  execFileSync("codesign", ["--deep", "--force", "--sign", "-", appPath], {
    stdio: "inherit",
  });
}
