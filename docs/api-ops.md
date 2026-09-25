# 監視・監査ログ・障害時の再送

この文書は API の運用方針の正本である（#122）。レート制限の上限値と
Managed AI の利用上限はこの文書の対象外で、[`docs/ai-limits.md`](ai-limits.md) と
その実装（#88 / #89）が持つ。

## 監視する指標と確認場所

`apps/api/wrangler.jsonc` は `observability.enabled` と `head_sampling_rate: 1` を
設定しており、Workers のメトリクスとログは既に収集されている。
**確認場所は Cloudflare ダッシュボード**（Workers & Pages → gakushu-sochi-api の
Metrics と Workers Logs）に限り、外部の監視基盤へは出さない。

| 指標               | 見る場所                                                                              | 異常の目安                                                                 |
| ------------------ | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| API の 5xx         | Metrics のステータス別リクエスト数。原因の内訳は Workers Logs の `unhandled error`    | 5xx が継続して出る                                                         |
| 認証の障害         | Workers Logs の `authentication is unavailable` / `unexpected authentication failure` | これらのログが出ること自体が異常。401 自体は期限切れトークンで正常に起きる |
| AI 経路の失敗      | Workers Logs の `ai upstream request failed` / `ai service is not configured`         | 継続した到達。`ai usage token safety valve reached` は政策値の見直し信号   |
| レート制限への到達 | Metrics の 429 と、Workers Logs の `rate limit reached`（path と userId を残す）      | 同じ利用者での到達が続く                                                   |

アラートは張らない。利用者が開発者自身を含む少数の段階では、閾値を決める根拠が
無く、アラート疲れの元になるだけである。障害は利用者からの報告と、
ダッシュボードの週1回程度の目視で拾う。実際のトラフィックが見えてから閾値を決める。

## 監査ログ

「誰がいつ何をしたか」を追う記録。対象・保存先・保存期間は次のとおり。

| 対象                                                       | 記録するもの           | 記録する場所                      |
| ---------------------------------------------------------- | ---------------------- | --------------------------------- |
| 学習履歴のエクスポート（`GET /v1/learning-events:export`） | userId、時刻、件数     | D1 `audit_log`                    |
| 学習履歴の削除（`DELETE /v1/learning-events`）             | userId、時刻、削除件数 | D1 `audit_log`                    |
| 退会（`DELETE /v1/me`）                                    | userId、時刻           | Workers Logs（`account deleted`） |
| ログイン・ログアウト・トークン撤回                         | Auth0 側の記録         | Auth0 テナントログ                |

- **保存先は D1 の `audit_log` テーブル**（`apps/api/migrations/0006_audit_log.sql`）。
  操作の記録は `AuditLogRepository`（`apps/api/src/repository/types.ts`）経由で追記する。
  読み出す API は持たない。運用者が `wrangler d1 execute` で直接クエリする。
- **保存期間は学習イベントと同じく無期限**
  （[`data-privacy.md`](data-privacy.md)「保存期間と削除」と揃える）。
  ただし `user_id` は `users(id)` を `ON DELETE CASCADE` で参照するため、
  **退会すると監査ログも一緒に消える**。退会した利用者の記録を残すことは
  「退会でアカウントごと全データを消す」方針に反する。
- その代わりに、**退会そのものの証跡は D1 ではなく Workers の構造化ログで追う**。
  `DELETE /v1/me` が完了すると `account deleted` を `console.info` で出す。
  `audit_log` に書いても users 行の削除で一緒に消えるため、テーブルには残さない。
- **ログイン・ログアウト・撤回は API Server が見ない**。認証は Auth0 が完結させるため、
  これらの記録は Auth0 のテナントログにしか存在しない。**Free プランの保持期間は
  1日**であり、それを超える追跡はできない。長期の追跡が必要になった時点で
  Log Streaming（Essentials 以上）を検討する。
- **学習イベント本体は `learning_events` が正本なので二重に持たない。**
  習熟度の手動上書き（`mastery_overrides`）や設定変更（`user_settings`）は
  取り消せる操作であり対象にしない。「いつ誰が変えたか」を追う必要が
  実際に出た時点で `AuditAction` へ足す。
- 監査ログの記録に失敗したら例外として伝播させる（RULE-004）。記録だけ落として
  操作は成功、という状態は「追えない操作」を生む。
- **記録は試行ごとに追記される。** たとえば `DELETE /v1/learning-events` で
  `audit_log` への書き込みが失敗して 5xx を返した後に利用者がリトライすると、
  2回目の削除（deletedCount=0）も別の行として残る。追記のみの監査ログの性質上、
  冪等な操作の重複行は許容する。
- **退会のトゥームストーンが残っている間、エクスポートと履歴削除は 5xx になる。**
  `audit_log.user_id` の外部キーを満たすため `ensureUser` を先に呼ぶが、
  退会処理中の利用者に対しては `user deletion is in progress` で失敗する。
  退会済みアカウントの操作が拒否されるのは意図した挙動である。

## 障害時の再送

現行の実装（`apps/vscode-extension/src/learning/sync.ts` と
`extension.ts` の `persistEvent`）が実際に行うこと:

- イベントは記録のたびに **1回だけ**送る。再試行も再送キューも無い。
- 応答を待つ上限は 10 秒（`AbortSignal.timeout`）。
- 失敗（ネットワーク断、タイムアウト、5xx、応答の破損、401「再ログインが必要です」）は
  すべて出力チャンネルへ記録するだけで、**利用者へは通知しない**。質問フローも止めない。
- 送れなかったイベントは `globalState` の `LearnerProfile.events` に残るが、
  **未送信の印は付かず、後から再送されない**。

**方針: 現時点では再送しない。初回の送信に失敗した時点で諦める。**

- イベント1件の欠落は学習体験を止めない。AI 経路は同期基盤と独立しており、
  同期が落ちても質問は続けられる
  （[`architecture.md`](architecture.md)「段階的な移行」の Phase 1 の方針）。
- 手元の `LearnerProfile` は欠けないため、VS Code 内での体験は守られる。
  欠けるのはサーバー側の正本だけで、症状としては他端末・Web 側の履歴に穴が開く。
- サーバーは event ID で冪等に受け付ける（`ON CONFLICT DO NOTHING`）ため、
  将来キューを実装して同じイベントを送り直しても二重記録されない。
  削除より前に受け取ったイベントは `learning_history_resets` が書き込みを塞ぐため、
  再送で消した履歴が蘇ることもない。再送機構はいつでも後付けできる。

**401 が続く間は同期がすべて失敗する。** トークンの失効は利用者へ通知されず、
出力チャンネルにだけ残る。これは現行実装との一致を優先した方針であり、
「同期がずっと落ちている」状態を利用者が自力で気付けない点は既知の隙間として認める。

**再送キューを実装する条件**: Web や他端末での履歴の欠落が実際の問題として
観測されたら、未送信の印を `globalState` に持つ永続キューを実装する。
そのときは、起動時と接続回復時にまとめて送ること、件数と期限の上限、
諦めたときに利用者へ伝える方法を決めてからこの節を更新する。
