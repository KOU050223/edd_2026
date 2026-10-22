// out/ のバンドルサイズ（gzip）を上限と比較する。
// 上限を上げるときは理由を PR に書く。
//
// 使い方: node scripts/check-bundle-size.mjs  （apps/desktop の build 済みであること）

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

const outDir = path.resolve(import.meta.dirname, "..", "out");

// 実測値（2026 年 3 月、Vite 8 + React 19 + Valibot 構成）
//   main index.js gzip 71.9 KiB / preload index.cjs gzip 0.9 KiB
//   renderer JS gzip 76.9 KiB / renderer CSS gzip 3.2 KiB
// 上限は実測に 15〜20% の余裕を足した値。
const KiB = 1024;
const LIMITS = [
  { name: "main", pattern: /^index\.js$/, dir: "main", limit: 85 * KiB },
  { name: "preload", pattern: /^index\.cjs$/, dir: "preload", limit: 2 * KiB },
  { name: "renderer JS", pattern: /\.js$/, dir: path.join("renderer", "assets"), limit: 90 * KiB },
  { name: "renderer CSS", pattern: /\.css$/, dir: path.join("renderer", "assets"), limit: 4 * KiB },
];

const failures = [];

for (const { name, pattern, dir, limit } of LIMITS) {
  const absDir = path.join(outDir, dir);
  let total = 0;
  let files;
  try {
    files = readdirSync(absDir).filter((f) => pattern.test(f));
  } catch {
    failures.push(`${name}: ${absDir} を読めません（npm run build 済みですか）`);
    continue;
  }
  if (files.length === 0) {
    failures.push(`${name}: ${dir} に対象ファイルがありません`);
    continue;
  }
  for (const f of files) {
    total += gzipSync(readFileSync(path.join(absDir, f))).length;
  }
  const totalKiB = (total / KiB).toFixed(1);
  const limitKiB = (limit / KiB).toFixed(0);
  if (total > limit) {
    failures.push(
      `${name}: gzip 合計 ${totalKiB} KiB が上限 ${limitKiB} KiB を超えています（${files.join(", ")}）`,
    );
  } else {
    console.log(
      `  ${name}: gzip 合計 ${totalKiB} KiB / 上限 ${limitKiB} KiB（${files.join(", ")}）`,
    );
  }
}

if (failures.length > 0) {
  console.error("バンドルサイズの検査に失敗しました:");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("OK: バンドルサイズはすべて上限以内です");
