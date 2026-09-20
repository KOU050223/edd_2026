---
name: task-manager
description: Gakushu Sochi の Issue を作るときの書式を定める。タイトルの規約、本文の節構成、ラベル、依存関係の登録方法に使う。「Issue を作って」「タスクを追加」「この作業を Issue に起こして」と言われたら起動する。
---

# Issue の書式

`KOU050223/edd_2026` の Issue を作るときの書式。

**Project 8「Gakushu Sochi」への登録は Auto-add workflow が自動で行う。**
新規 Issue は作成しただけで Status `Todo` で入る。手で追加しないこと。

## タイトル

`領域/連番: 動詞形の要約`（例 `診断/02: 同じエラーの再発を検知する`）。

既存の領域は 基盤 / 設計 / 調査 / 選択 / 質問 / 表示 / AI / 診断 / Web / MVP。
連番はその領域の既存最大値+1。バグや雑務は `fix:` `docs:` `deploy:` を使う。

ラベルは `enhancement` / `bug` / `documentation` / `question` から選ぶ。

## 本文

既存の書式に必ず揃える。逸脱すると読み手が探す場所が変わる。

```markdown
## 目的

（なぜ要るか。docs/idea.md や docs/architecture.md の記述と、
実コードの現状を根拠として引く。ファイル:行 で示す）

## 依存

- 領域/連番 (#N): タイトル

## 変更対象

- パス

## 実装計画

1. 手順。決め打ちできない設計判断は「決める」と書いて選択肢を並べる。

## 完了条件

- [ ] 検証可能な条件

## スコープ外

- 他 Issue が持つ範囲
```

```bash
gh issue create --title "..." --label enhancement --body-file /tmp/body.md
```

**作成前にユーザーへ内容を提示して承認を得る。** Issue 作成は外向きの操作で、
取り消しが面倒なため。既存 Issue と重複していないことも併せて示す。

**本文を空のまま作らない。** 空の Issue は AI にも人にも投げられず、
結局あとで書き直すことになる。まだ内容が固まっていないなら、
「決めること」を並べた本文にする。

## 依存関係

GitHub ネイティブの依存関係を使う。`## 依存` セクションは理由の記述として残すが、
**機械が読む正本は blocked by** である。木ではなく DAG なので複数依存も入る。

```bash
gid(){ gh api graphql -f query="query{repository(owner:\"KOU050223\",name:\"edd_2026\"){issue(number:$1){id}}}" --jq '.data.repository.issue.id'; }
# $1 が $2 に塞がれている、を登録する
gh api graphql -f query="mutation{addBlockedBy(input:{issueId:\"$(gid 85)\",blockingIssueId:\"$(gid 84)\"}){issue{number}}}"
```

**入力名に注意。** `AddBlockedByInput` が取るのは `blockingIssueId` であって
`blockedByIssueId` ではない。後者を渡すと `argumentNotAccepted` で落ちる。
既に登録済みの組を再度登録すると `Target issue has already been taken` が返る。
一括登録するときは `set -e` を使わず、このエラーを読み飛ばすこと。

読み出しは `gh issue view <番号> --json blockedBy,blocking,parent,subIssues`。

**今すぐ着手できる Issue の一覧**は次で出る。

```bash
gh issue list --state open --limit 100 --json number,title,blockedBy \
  --jq '.[] | select([.blockedBy.nodes[] | select(.state=="OPEN")] | length == 0) | "#\(.number) \(.title)"'
```

## クローズ

Issue を閉じれば Project の Status も `Item closed` workflow が Done へ動かす。
片方だけ手で動かさないこと。

```bash
gh issue close 75 --comment "..."
```
