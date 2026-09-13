# 却下したルール候補

`npm run harvest:rules` が出した候補のうち、**ルールにしないと判断したもの**を記録する。

記録しないと、その候補は収穫のたびに何度でも出てくる。
通知が同じ内容を繰り返せば数週間で無視されるようになり、仕組み全体が死ぬ。
**採らないことも決定である。理由を残す。**

## 書式

クラスタのキーをバッククォートで囲んで先頭に置く。
このキーで収穫スクリプトが照合するので、`harvest:rules` の出力からそのまま写すこと。

```markdown
- `カテゴリ | 領域` — 却下理由（YYYY-MM-DD）
```

## 一覧

- `🩺 Stability & Availability | src/extension.ts` — PR#48 のモノレポ移行で
  `apps/vscode-extension/src/` へ移った旧パスのクラスタ。移行後の同じ問題は
  `🩺 Stability & Availability | apps/vscode-extension` に含まれ、そちらは RULE-004 として
  採用済み。パス単位でクラスタを作る都合で分裂しただけなので、重複として却下する（2026-09-10）

- `🗄️ Data Integrity & Integration | apps/desktop` — 修正実績が 1 件のみ。両方とも
  `selection.ts` のクリップボード復元という Electron 固有の実装詳細で、一般則に昇格しない
  （2026-09-12）
- `🎯 Functional Correctness | test/project-rules.test.mjs` — 全件が PR#98 単独。
  ガードレールの検出器を書いたその回の指摘であり、再発クラスタではない。
  内容（判定は違反側へ倒す、AST で解析する）は docs/guardrails.md の
  「検出器そのものを検証する」「既知の限界」に記載済み（2026-09-12）
- `🗄️ Data Integrity & Integration | scripts/harvest-review-rules.mjs` — 同上。PR#98 単独・
  同一ファイル。部分取得を成功として返さない点は RULE-004 が既に覆う（2026-09-12）
- `🎯 Functional Correctness | scripts/harvest-review-rules.mjs` — 同上。PR#98 単独・
  同一ファイル。採用済み判定の仕様は docs/guardrails.md の「なぜ却下の記録が必要か」に記載済み
  （2026-09-12）
