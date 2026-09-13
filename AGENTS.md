# 開発ルール

**エラーを握りつぶすな！**

失敗を黙って飲み込むな。空の `catch` を書かず、フォールバックで失敗を隠さず、
HTTP 2xx でも本文の解析に失敗したならそれは失敗として扱う。

---

## テスト

自動テストの方針・書き方・実行方法は [docs/testing-guide.md](docs/testing-guide.md) を正典とする。
手動確認の手順は [docs/testing.md](docs/testing.md)。

ロジックを変える PR は実装と同じ PR でテストまで終わらせる。
ワークスペース固有の事情（テストの置き場所、外部依存の差し替え方）は各 `AGENTS.md` にある。

---

## プロジェクト固有のルール

PR レビューで繰り返し指摘されたパターンを `.agents/rules/rules.md` に正典としてまとめている。

次の行は Claude Code が展開し、正典の全文をそのままコンテキストへ載せる。
**Codex はこれを展開しない（実測済み）。Codex で作業するときは、下の表を見て
関係しそうなルールがあれば `.agents/rules/rules.md` を必ず開くこと。**

@.agents/rules/rules.md

### ルール一覧

| ID       | 要旨                                                                            | 強制                 |
| -------- | ------------------------------------------------------------------------------- | -------------------- |
| RULE-001 | 単発の外向き `fetch` にはタイムアウトを設定する（ストリーミング・中継は対象外） | test                 |
| RULE-002 | 資格情報を載せた `fetch` は `redirect: "error"` を指定する                      | test（検出は限定的） |
| RULE-003 | 設定由来の送信先 origin は HTTPS かループバックに限定する                       | test                 |
| RULE-004 | エラーを握りつぶすな                                                            | lint + doc           |
| RULE-005 | 再実行されうる読み込みは古い応答で新しい表示を上書きしない                      | doc                  |
| RULE-006 | 資格情報を左右する設定は信頼できない場所から上書きさせない                      | doc                  |
| RULE-007 | 送信中の再送信を状態で止める                                                    | doc                  |

検査は `npm run test:project-rules`。CI と lefthook の pre-push から自動で走る。

## ルールを増やすとき

`main` への push で収穫が自動的に走り、**新しい候補があるときだけ** Issue が立つ。
手元で見るときは次を叩く。

```bash
npm run harvest:rules -- --new-only
```

過去の PR レビューを収集し、**同じクラスの指摘が 2 件以上あり、かつ実際に修正されたもの**を
ルール候補として提示する。1 件きりの指摘はルールにしない（直して終わり）。

候補は必ずどちらかに倒す。**放置すると毎回また出てくる。**

- 採用 → `.agents/rules/rules.md` に出典 PR 付きで追記。
  機械的に検査できるものは `test/project-rules.test.mjs` にテストを足す。
- 却下 → `.agents/rules/declined.md` に理由付きで記録。

判定できるものを markdown に書かないこと — markdown は助言、CI は強制。

**ルールの追記は自動化しない。** 候補の提示までが機械の仕事で、採否は人間が決める。

棚卸しの手順は `.agents/skills/rule-harvest/SKILL.md` にまとめてある。
出典の書式やクラスタのキーを間違えると、採用したのに候補が出続ける。
**候補を扱うときは必ずこれを開くこと**（Claude Code はスキルとして自動で拾うが、
他のエージェントは自動で読まないので、パスを指定して開かせる）。

仕組みの狙いと運用は [docs/guardrails.md](docs/guardrails.md) を参照。

## スキルの置き方

スキルは `skills` CLI（npm）で入れる。対象は Claude Code と Codex の 2 つだけ。

```bash
npx skills add ./.agents/skills/<名前> --agent claude-code codex -y
```

実体は `.agents/skills/<名前>/`（Codex がそのまま読む）、
`.claude/skills/<名前>` はそこへのシンボリックリンク（Claude Code が自動で拾う）。
台帳は `skills-lock.json`。

**`npx skills experimental_install` はエージェント連携を復元しない（実測）。**
`.agents/skills/` は戻るが `.claude/skills/` のリンクは作られず、
しかも終了コードは 0 になる。だから `.claude/skills/*` のリンクは git で追跡している。
**これを gitignore すると、clone した人の Claude Code からスキルが黙って消える。**
