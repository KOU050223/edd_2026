# 会話履歴（Conversation）

Issue #204。質問と回答を保存し、後から見返せる履歴を作るための基盤を決める文書である。

Desktop の左サイドバーへの履歴表示（#199・#205）と Web からの閲覧（#206）は
この基盤の上に乗る子 Issue である。ここでは保存・読み出し・削除の境界だけを決め、
画面の設計は各 Issue に委ねる。

## 保存するもの

保存対象は「選択テキスト」「質問文」「AI の回答」の3つである。
既定の質問文が「この選択テキストを初心者にも分かるように解説してください」
である以上、選択テキストを抜いた履歴は何について聞いたかを再生できない。

VS Code で AI が受け取る周辺コード・定義・Diagnostics は保存しない。
履歴を見返すときに必要なのは「何を選んで、何を聞いて、何と答えられたか」であり、
選択範囲の外のコードまで残すと保存量と機密の度合いが跳ね上がる。
必要になったときは省略可能フィールドの追加で済む。

## LearningEvent とは別のリソース

|            | LearningEvent  | Conversation                      |
| ---------- | -------------- | --------------------------------- |
| 中身       | メタデータのみ | 選択テキスト・質問・回答の本文    |
| 用途       | 習熟度の導出   | 履歴の閲覧                        |
| 保存の条件 | 送信の同意     | 送信の同意 + 履歴保存のオプトイン |
| 削除の粒度 | 全件のみ       | 1件ずつ・全件                     |

`learning_events` に本文を混ぜない。`learningEventSchema` が `strictObject` で
「本文の置き場が無い」ことを保証している境界を壊すと、メタデータだけを信用している
読み取り側すべてが本文を扱う可能性を考え直すことになる。

Conversation は習熟度の根拠ではないため、イベントと違って1件単位で消せる。

## オプトイン

本文の長期保存は [`docs/data-privacy.md`](data-privacy.md) の方針上、
目的・保存期間・削除方法を明示したオプトインが前提である。

### フラグの置き場所

`user_settings` に `saveConversationHistory: boolean`（既定 `false`）を追加する。
サーバー側に置くのは、1つのスイッチで全端末の保存を止められることと、
Web の設定画面からも状態が見えることを両立させるためである。

`UserSettings` のバージョンは上げない（省略可能フィールドの追加は既存の規則で
据え置き）。`PUT /v1/user-settings` の入力ではこのフィールドを省略可能とし、
**省略されたときは保存済みの値を維持する**。上書き型の設定更新にそのまま載せると、
古いクライアントが設定を保存するたびにオプトインが黙って外れる。
実装上はルートが現在値を読んでからマージして書く。

### 二重のゲート

保存は2箇所で止める。

1. **送信前**: クライアントはフラグがオフなら本文を組み立てて送らない。
   キャッシュした値を使い、オフラインや応答遅延で質問フローが止まらないようにする。
2. **サーバー側**: `PUT /v1/conversations/:id` は保存前に
   `saveConversationHistory` を読み、有効でなければ `403 conversation_history_disabled`
   を返して何も書かない。クライアントのキャッシュが古くても、バグがあっても、
   オプトイン無しに本文は保存されない。

### 有効化の文面

オプトインをオンにする操作では、次を明示した文面を出す（文面は
`packages/domain` に置き、クライアント間で共有する）。

- 目的: 質問と回答を後から見返せるようにするため
- 保存期間: 削除するまで無期限
- 削除方法: 履歴の1件削除・全件削除・「学習データを削除する」・退会

### 送信の同意との関係

履歴の保存とは別に、本文を端末の外へ出す行為であるため既存の送信同意
（`CONSENT_NOTICE`）の対象である。同意が無い・取り消された状態では
アップロード自体を行わない。

`CONSENT_NOTICE` は v5 で「コード本文・質問文・AIの回答を学習記録として
保存することはありません」と明言しており、この文面は本機能と矛盾する。
**版を 6 へ上げて文面を更新し、同意を取り直す。** オプトインが別にあっても、
「保存しない」という記述を残したままでは同意の前提が崩れるため、
同意の取り直しを発生させてでも文面を事実に合わせる。

## データモデル

1会話を、クライアントが採番した ID を持つ1レコードとして保存する。
Desktop の「選択 → 質問 → 回答」の1往復、VS Code の1リクエストがそれぞれ
1会話になる。将来マルチターンの会話が入っても、同じ ID へ会話全体を
upsert する形でスキーマを変えずに収まる。

### ドメイン型（`packages/domain/src/conversation.ts`）

```ts
export type ConversationOrigin = "desktop" | "vscode" | "web" | "cli";

export type ConversationMessageRole = "context" | "user" | "assistant";

export interface ConversationMessage {
  role: ConversationMessageRole; // context = 選択テキストなどの文脈
  text: string;
  at: string; // ISO 8601
}

export interface Conversation {
  id: string; // クライアント採番。VS Code は sessionId を流用する
  origin: ConversationOrigin;
  clientId?: string; // どの端末からか（診断・端末別表示の材料）
  title?: string; // 一覧用。クライアントが質問の先頭行から付ける
  language?: string; // 選択テキストの言語識別子
  fileName?: string; // 選択元のファイル名（取得できた場合のみ）
  occurredAt: string; // 最初の質問時刻
  updatedAt: string; // 最後のメッセージ時刻
  complete: boolean; // 回答が最後まで届いたか。中断は false
  messages: ConversationMessage[];
}
```

`Conversation.id` と `LearningEvent.sessionId` を同じ採番にすると、
習熟度の根拠となったイベントから履歴本文へ辿れる。
VS Code はリクエストごとに採番している `sessionId` をそのまま会話 ID に使う。
Desktop は質問のたびに UUID を採番する（Desktop が将来イベントを送るときも
そのまま `sessionId` になれる値）。

### テーブル（`apps/api/migrations/0009_conversations.sql`）

```sql
CREATE TABLE conversations (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  origin TEXT NOT NULL,
  client_id TEXT,
  title TEXT,
  language TEXT,
  file_name TEXT,
  messages TEXT NOT NULL,          -- JSON: ConversationMessage[]
  message_count INTEGER NOT NULL,
  complete INTEGER NOT NULL DEFAULT 1,
  occurred_at TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  received_at_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)        -- イベントと同じくユーザー単位の冪等性
);
CREATE INDEX idx_conversations_user_updated
  ON conversations (user_id, updated_at_ms, id);
```

`messages` を正規化せず JSON 列にするのは、`concept_ids` を JSON 文字列で持つ
既存の流儀に合わせるためである。メッセージ単位で読む操作は今のところ存在せず、
会話単位で読み書きすれば足りる。

## API

| メソッドとパス                 | 内容                                   |
| ------------------------------ | -------------------------------------- |
| `PUT /v1/conversations/:id`    | upsert。本文を含む会話全体を受け取る   |
| `GET /v1/conversations`        | 一覧。メタデータのみ（本文は返さない） |
| `GET /v1/conversations/:id`    | 本文込みの詳細                         |
| `DELETE /v1/conversations/:id` | 1件削除                                |
| `DELETE /v1/conversations`     | 全件削除。オプトインを切るときの掃除用 |
| `GET /v1/conversations:export` | 全件エクスポート。取り出し権の対称性   |

### `PUT /v1/conversations/:id`

- パスの `:id` と本文の `id` が一致しない場合は 400。
- `saveConversationHistory` が有効でなければ `403 conversation_history_disabled`。
  本文は保存しない。
- 既存行より `updated_at` が古い会話が届いた場合は書き換えず
  `{ saved: false, reason: "newer_exists" }` を返す。遅延した再送や
  古いスナップショットで新しい履歴が巻き戻るのを防ぐ。
- 検証は `strictObject` で行い、拒否理由には値ではなくパスと要約だけを返す
  （`learning-events` と同じく、エラーメッセージ経由で本文を漏らさない）。
- 上限: `id` は128文字、`messages` は50件、role ごとの本文長は
  `context` ≤ 20,000・`user` ≤ 4,000・`assistant` ≤ 100,000 文字、
  全メッセージの合計は256,000文字まで。いずれも既存の入力上限
  （`apps/api/src/routes/ai.ts` の selection / question 上限）と揃える。
- `occurredAt`・`updatedAt`・各メッセージの `at` は `isIsoDateTime` で
  パースできることだけを受け付ける。学習イベントと同じく、辞書順に頼る
  比較を成立させないためである。

### `GET /v1/conversations`

- `updated_at_ms` の降順（同時刻は `id` 昇順）、`limit`（既定50・上限100）と
  カーソルでページングする。
- 返すのは `ConversationSummary`（`id` `origin` `title` `language` `fileName`
  `occurredAt` `updatedAt` `messageCount` `complete`）だけであり、
  `messages` の本文は含めない。サイドバーの一覧が重くならないようにするためと、
  一覧を開くだけで本文全件がブラウザへ出る事態を避けるためである。
- 応答は `cache-control: no-store`（Web 中継でキャッシュに残さない既存方針と同じ）。

### 削除

- `DELETE /v1/learning-events`（学習履歴の削除）は会話も一緒に消し、応答に
  `deletedConversationCount` を足す。「履歴を消したのに質問履歴が残る」
  状態を作らないためである（#157 で Evidence を畳み込んだのと同じ判断）。
- 退会（`DELETE /v1/me`）は `ON DELETE CASCADE` で消える。
- 監査ログに `conversations.deleted` を追加する（`AuditAction` の拡張）。
  不可逆な操作なので件数を残す。

### レート制限

`/v1/conversations*` は `PROFILE_RATE_LIMITER` を使う。一覧・詳細は読み取り、
書き込みも質問1回につき1回で、いずれも Profile と同程度の頻度想定である。

## 書き込み経路

本文をサーバーへ送るのはクライアントの役目であり、`/v1/ai/responses` の
処理系には手を入れない。Managed AI の経路上に本文が流れているからといって
サーバー側で横取りして保存すると、書き込み経路が「アップロード」と
「ストリーム捕捉」の2系統になり、保存の成否を利用者へ説明しづらくなる。
VS Code の経路は本文がサーバーを一度も通らないため、どのみち
アップロードの経路は要る。書き込み経路は1本に揃える。

### Desktop

```
answer:ask
  → ensureConsent()                              # 既存
  → conversationId = UUID を採番、occurredAt を記録
  → askManagedAI(...) のストリーム delta を蓄積
  → 回答本文が1文字でも届いたら、ローカルにキャッシュした saveHistory が
    有効なとき PUT /v1/conversations/:id へ送信
    （complete に完了/中断を反映）
```

回答が1文字も届かなかった失敗（上限到達・上流障害など）は履歴にしない。
「聞いたが答えが無かった」記録は見返す価値がなく、失敗の理由は
画面のエラー表示とログが担う。

保存の失敗は回答の表示を止めない（回答はすでに届いている）が、
黙っても落とさない。ログへ残し、renderer へ「履歴を保存できませんでした」と
通知する（RULE-004）。`403` が返った場合はサーバー側でオプトインが
外れている確定情報なので、ローカルのキャッシュも false に倒す。

設定画面に「質問履歴を保存する」の切り替えを置く。切り替えは
`PUT /v1/user-settings` を呼び、成功した値を `settings.json` の
`saveConversationHistory` にもキャッシュとして残す。画面を開いたときは
`GET /v1/user-settings` で表示する。オフラインでは変更できず、
失敗はそのままエラー表示する。

### VS Code 拡張

Chat Participant が `aiResponse.ok` を受け取ったあと、既存の
`persistEvent` と同じ位置で、同じ `sessionId` を会話 ID にして
`PUT /v1/conversations/:id` する。メッセージは
`context`（`CodeContext.code`）→ `user`（質問）→ `assistant`（回答本文）
の3件で、`language`・`fileName` も `CodeContext` から取る。

フラグは `globalState` の `gakushuSochi.saveConversationHistory` に
キャッシュする。設定項目にはしない。送信の可否を左右する値を
ワークスペース設定が上書きできる場所に置くと、開いたリポジトリが
利用者の意思を偽装できてしまう（RULE-006 と同じ理屈）。

切り替えはコマンド `Gakushu Sochi: 質問履歴の保存を切り替える` とし、
オプトインの文面を表示してから `PUT /v1/user-settings` を呼ぶ。
同期と同じく、失敗は出力チャンネルに残すだけで質問フローは止めない。

## 保存期間と既知の限界

保存期間は**無期限**とし、利用者がいつでも消せる経路を用意する
（学習イベントと同じ方針）。「削除するまで残る」ことをオプトインの文面に書く。

受け入れる限界は2つある。

- **削除直後の復活**。`DELETE /v1/conversations/:id` の直後に遅延した
  upsert が同じ ID を書き戻しうる。`learning_history_resets` に相当する
  仕組みを会話にも持つのは、削除した内容の ID 一覧を残すことになり
  「消した履歴の記録」そのものになる。削除は利用者の明示的な操作で、
  アップロードは質問の直後に起きるため実害は稀であり、残ったら
  再度消せばよい運用で許容する。
- **中断した回答**。アプリの終了やネットワーク断でストリームが途切れた
  会話は `complete: false` として保存する。届いた部分までが履歴であり、
  不完全であることを表示側が区別できるようにする。

## 実装の段階

1. `packages/domain` に `conversation.ts`（型とオプトイン文面）を追加し、
   `consent.ts` の版を 6 へ上げて文面を更新する。
2. `apps/api` にマイグレーション・契約・ルート・リポジトリを追加し、
   `user_settings` に `saveConversationHistory` を足す。
   `DELETE /v1/learning-events` の削除対象に会話を含める。
3. Desktop に設定画面の切り替えと `answer:ask` 後のアップロードを実装する。
4. VS Code 拡張に切り替えコマンドと Participant 後のアップロードを実装する。
5. [`docs/data-privacy.md`](data-privacy.md)（二段階表・送信先表・同意節）、
   [`docs/architecture.md`](architecture.md)（API 境界の表）、
   `apps/desktop/AGENTS.md`・`apps/api/AGENTS.md`（「本文を永続化しない」
   規則にオプトイン時の例外を追記）を更新する。

テストは `docs/testing-guide.md` の方針に従う。API は契約（strictObject・上限・
ISO 検査）、オプトイン強制（403）、upsert の冪等と古い値の拒否、一覧の順序と
ページング、削除の連動をインメモリリポジトリで固定する。クライアント側は
ストリームから会話を組み立てる部分を純粋関数へ切り出して検証する。

## 関連文書

- [`docs/data-privacy.md`](data-privacy.md): 保存対象の二段階・送信範囲・同意の正本
- [`docs/architecture.md`](architecture.md): API の境界とオフライン方針
- [`docs/concepts.md`](concepts.md): LearningEvent と習熟度の契約
- `apps/api/src/contract/learning-event.ts`: イベント同期の契約（本機能とは別物）
