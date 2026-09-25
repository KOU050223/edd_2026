#!/usr/bin/env node
// GitHub Release の dmg から Homebrew Cask を生成し、homebrew-tap リポジトリへ書き出す。
//
// release-desktop.yml から呼ぶ。Cask の正本は homebrew-tap 側の Casks/gakushu-sochi.rb で、
// このスクリプトはリリースごとにそれを丸ごと上書きする。手編集した内容は残らない。
//
//   node scripts/gen-cask.mjs \
//     --version 0.1.0 \
//     --sha256-arm <hex> --sha256-intel <hex> \
//     --out homebrew-tap/Casks/gakushu-sochi.rb

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    version: { type: "string" },
    "sha256-arm": { type: "string" },
    "sha256-intel": { type: "string" },
    out: { type: "string" },
  },
});

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

// 壊れた値を埋め込んだ Cask を流すと brew install が毎回 sha256 不一致で落ちる。
// 理由がわかりにくいので、書き出す前に全部検査して失敗させる。
const errors = [];
if (!VERSION_PATTERN.test(values.version ?? "")) {
  errors.push(`--version が semver 形式ではない: ${values.version}`);
}
for (const [name, value] of [
  ["--sha256-arm", values["sha256-arm"]],
  ["--sha256-intel", values["sha256-intel"]],
]) {
  if (!SHA256_PATTERN.test(value ?? "")) {
    errors.push(`${name} が 64 桁の hex ではない: ${value}`);
  }
}
if (!values.out) errors.push("--out が無い");
if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}

// dmg のファイル名は apps/desktop/package.json の artifactName と対になる。
// 変えるときは両方同時に変えないと URL が壊れる。
const cask = `cask "gakushu-sochi" do
  version "${values.version}"

  arch arm: "arm64", intel: "x64"

  sha256 arm:   "${values["sha256-arm"]}",
         intel: "${values["sha256-intel"]}"

  url "https://github.com/KOU050223/edd_2026/releases/download/desktop-v#{version}/Gakushu-Sochi-#{version}-mac-#{arch}.dmg"
  name "Gakushu Sochi"
  desc "選択したテキストをすぐに質問できる常駐型 AI コンパニオン"
  homepage "https://github.com/KOU050223/edd_2026"

  app "Gakushu Sochi.app"
end
`;

writeFileSync(values.out, cask);
console.log(`${values.out} を ${values.version} で書き出した`);
