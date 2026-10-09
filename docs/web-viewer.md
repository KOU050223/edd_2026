# Web Viewer 設計

Issue #67「閲覧機能」。D1 に蓄積した学習イベントを Web から閲覧する。

> **認証の正典は [`auth.md`](auth.md) §5.3 である。** 本書は認証フローの設計を持たない。
> ログインは Auth0 の Authorization Code + PKCE で、`/api/*` にはセッションの
> 利用者本人のアクセストークンが載る。起票時に設計した共有パスフレーズ
> （`WEB_ACCESS_PASSPHRASE`）と共有 `API_TOKEN` は Auth/05（#84）で置き換わり、
> Auth/06（#85）で secret ごと削除した。本書には残っていない。

## 位置づけと範囲

docs/architecture.md「Phase 1: 最初の学習ループを完成させる」の
**「Web にログインと読み取り専用の Learning Map を置く」** を実装する。
この文がスコープの正典であり、本書はその具体化である。

範囲に**含む**もの。

- ログイン（後述の通り、Identity が無い間はゲートであり本人確認ではない）
- 習熟度の一覧表示（Learning Map）
- 学習の推移（集計済みの時系列）

範囲に**含まない**もの。理由を添えて明示する。

| 除外するもの                     | 理由                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 学習イベントの書き込み・編集     | 学習イベントは追記のみで、正本は Extension / Desktop からの同期である（architecture.md「オフラインと競合」） |
| 学習イベントの書き込み（例外）   | **確認問題の正誤だけは Web から記録する**（Web/05 #77）。後述「確認問題の正誤の記録先」                      |
| 学習イベントの生ログ表示         | data-privacy.md が生ログの送出を禁じている。集計済みの読み取りモデルだけを返す                               |
| ユーザー設定画面（起票時の除外） | 起票時は設定の書き込み API が無かったため除外した。後に Web/06（#123）で `/settings` として実装済み（後述）  |
| GraphQL / 汎用 BFF               | apps/web/AGENTS.md「汎用GraphQLや巨大なBFFを先行して導入しない」                                             |

## 資格情報をどこに置くか

**Web 固有の制約は「ブラウザに安全な保管場所が無い」ことである。** 誰であるかの識別は
Auth0 が担うが（`auth.md` §5.3）、受け取ったトークンをどこに置くかは本書の判断である。

起票時はまだ Identity が無く、`apps/api` の `devAuth` が単一の共有トークンを検証して
通過者全員を `dev-user` として扱っていた。下の3案はその時点の比較であり、
**採った案 A の構成は Identity 導入後もそのまま生きている**。変わったのは
Worker が注入するものが共有トークンから利用者本人のアクセストークンになった点だけである。

### 検討した3案

| 案                                                | 内容                                                                       | 判断              |
| ------------------------------------------------- | -------------------------------------------------------------------------- | ----------------- |
| A. Web を Worker にし、トークンはサーバー側に置く | ブラウザにはセッション Cookie だけを渡し、API 呼び出しは Worker 内から行う | **採用**          |
| B. ブラウザに `DEV_AUTH_TOKEN` を配る             | 実装は最小。ただしシステム全体の資格情報がブラウザに露出する               | 却下              |
| C. 先に Identity（OAuth）を作る                   | 正しい順序だが、本 Issue の範囲を大きく超える                              | 却下（別 Issue）※ |

※ 案 C は後に Auth/05（#84）として実装され、**案 A の上に載った**。
A と C は排他ではなく、当時は順序の問題だった。

**A を採る理由。**

1. 共有トークンはシステム全体の資格情報であり、個人ごとの資格情報ではない。
   ブラウザの JS から読める場所に置くと、XSS 一つで全ユーザーの学習履歴が読める。
   `apps/desktop/src/main/credentials.ts` が OS キーチェーンでトークンを守っているのと
   同じ原則を Web でも保つ。ブラウザに安全な保管場所が無いなら、置かない。
2. Web と API が同一生成元になれば CORS の問題が消える。
   現在 `CORS_ALLOWED_ORIGINS` は `""`（誰も許可しない）で、
   B や C ではここを開ける作業が必ず要る。
3. apps/web/AGENTS.md の「データベースへ直接アクセスしない。認証済みの API 契約だけを使う」を
   そのまま守れる。Worker は D1 バインディングを持たず、`fetch` で API を呼ぶだけにする。

### A の構成

```text
ブラウザ
  │  Cookie: session=<opaque>      （HttpOnly / Secure / SameSite=Lax）
  ▼
apps/web （Cloudflare Worker + static assets）
  │  Authorization: Bearer <利用者本人の Access Token>
  │  （Refresh Token から Worker 内で取得。ブラウザへ出さない）
  ▼
apps/api （既存）── D1
```

- `/login` → `/callback`: Auth0 の Authorization Code + PKCE。**フローの正典は
  `auth.md` §5.3。** Worker が認可コードを交換し、セッションを発行する。
- セッションは Workers KV に置く。値は乱数の opaque token、TTL は 7 日。
  JWT にしない。失効させたいときに撤回できないものを、認証の代わりに使わない。
  KV には Refresh Token を紐づけ、Access Token は Worker 内で都度取得・更新する
  （`src/worker/access-token.ts`）。
- `/api/*`: セッションを検証し、`apps/api` へ中継する。
  中継先の URL は var `API_ORIGIN`。`Authorization` は Worker が付け替える。
- `/consent`: 同意の記録の読み書き（#174）。中継ではなく Worker 自身の endpoint で、
  **同意が無くても呼べる**（同意状態を知る手段が同意で止まると先へ進めない）。
  書き込み系（GET / HEAD / DELETE 以外）の中継は同意の記録があるときだけ通す。
- `/session`: ログイン状態の確認（#182）。`{ loggedIn: boolean }` を返す。
  **未ログインでも 200 を返す**（ログインしているかを知る手段が 401 になると、
  未ログイン向けの画面を描けない）。`/consent` と同じ理由である。
- 静的アセットは同じ Worker から配信する（`assets` バインディング）。

**ブラウザへ渡すのは Cookie だけである。** Access Token も Refresh Token も
ブラウザへ出さない。案 A を採った理由（上記1）はここで守られている。

### パスの契約

**ブラウザが叩くのは `/api/v1/...`、API が受けるのは `/v1/...` である。**
Worker が先頭の `/api` を取り除いて `API_ORIGIN` へ転送する。

| ブラウザ                                | Worker の扱い         | 転送先                                       |
| --------------------------------------- | --------------------- | -------------------------------------------- |
| `GET /api/v1/learning-profile`          | セッション検証 → 中継 | `${API_ORIGIN}/v1/learning-profile`          |
| `GET /api/v1/learning-activity?days=30` | セッション検証 → 中継 | `${API_ORIGIN}/v1/learning-activity?days=30` |
| `POST /api/v1/learning-events:sync`     | 同意確認 → 中継       | `${API_ORIGIN}/v1/learning-events:sync`      |

ブラウザから直接 `/v1/...` を叩かない。`run_worker_first` が `/api/*` しか
Worker へ回さないため、`/v1/...` は Asset Worker が処理し、
`not_found_handling: "single-page-application"` によって
**JSON ではなく `index.html` が返る**。認証も中継も通らないまま、
クライアントは HTML を JSON としてパースして失敗する。
Worker のルート・`run_worker_first`・画面の fetch 先の3つは、
常に同じ `/api/*` を指していなければならない。

### 認証前エンドポイントの制限

パスワードの試行制限は IdP（Auth0）へ移った。それでも `/login` と `/callback` は
**認証前に叩ける経路**であり、叩かれれば Auth0 への外向き通信が発生する。
`SYNC_RATE_LIMITER` / `PROFILE_RATE_LIMITER` は `apps/api` 側の学習データ API 用で、
`apps/web` のこれらは保護していない。

`apps/web` の `wrangler.jsonc` に `LOGIN_RATE_LIMITER` を独立して定義する。

```jsonc
"ratelimits": [
  { "name": "LOGIN_RATE_LIMITER", "namespace_id": "2001",
    "simple": { "limit": 20, "period": 60 } },
],
```

- 数える単位は接続元 IP（`CF-Connecting-IP`）。認証前なので userId は無い。
- 上限を超えたら 429 を返す。理由を伏せない。
- **1回のログインが `/login` と `/callback` の2回を消費する。** パスフレーズ時代の
  5 回/分のままだと、やり直しを2回で使い切る。20 回/分にしてある。

**この上限が何でないかを書いておく。** Workers の Rate Limiting はカウンターを
**Cloudflare の location ごとに持つ**。したがって `limit: 20` は
「IP ごとに全世界で 20 回/分」ではない。リクエストが複数の location に分散すれば、
合計は 20 回/分を超えうる。

狙いは**誤操作や素朴な連打で Auth0 への外向き通信が積み上がるのを抑えること**であり、
分散した攻撃を止めることではない。後者は IdP 側の防御（Auth0 の
Attack Protection）に委ねる。厳密な全体上限が要るなら Durable Objects のような
強整合なカウンターが必要になるが、この目的には過剰なので採らない。

### セッションの整合性について認めておくこと

Workers KV は結果整合であり、書き込みと削除が別のエッジロケーションへ伝わるまで
**最大 60 秒程度かかりうる**。したがって次の2つが起こる。

- ログイン直後の最初のリクエストが、別ロケーションに当たると 401 になる
- ログアウトしても、伝播するまでの間は古いセッションが通る

**この遅延を許容する。** Durable Objects による強整合なセッションストアには**しない**。
ログイン頻度が低く、ログアウト時はブラウザの Cookie も同時に破棄するため、
伝播を待つ間に古いセッションが通ることの実害が小さいためである。
代わりに次で埋め合わせる。

- ログイン直後の 401 は、クライアントで**最大 3 回**再試行する
  （`client/session.ts` の `LOGIN_SESSION_RETRIES`、1 秒間隔）。
  再試行してよいかの印は Worker が返す `/?login=1` から sessionStorage へ移し、
  URL から消す。**再読み込みで再試行が復活しない**ようにするための一度きりの印である。
  それでも失敗したら通常のエラー表示にする。無限にリトライしない。
- ログアウトは KV の削除と同時に Cookie も破棄する。
  ブラウザ側の資格情報が消えるので、実用上の即時性はこれで足りる。
- 「ログアウトは即座に全世界へ反映されるわけではない」ことを設計上の既知の性質として残す。

**Auth/05（#84）で Identity を入れた後も、この判断は維持している。** API が 401 を
返した場合は KV のセッションを削除する（`src/worker/index.ts`）。Cookie だけを消すと、
コピーされた Cookie を持つ誰かが refresh を回して使い続けられるためである。

**ただしこの削除も即時失効ではない。** 削除自体が KV への書き込みであり、上と同じ
伝播遅延を受ける。他の location には削除前の値が残るため、その間はコピーされた
Cookie からセッションを読み直して Refresh Token を使える。同じ location でも
即時反映は保証されていない。
**「401 を見たら即座に失効する」とは書けない。削除は失効を早める措置であって、
保証ではない。** 失効の実効的な上限は Refresh Token の寿命と、Auth0 側での撤回である。

即時失効が要件になったら、KV 以外の強整合な失効確認（Durable Objects、または
API 側でのトークン失効）をその時点で検討する。

### キャッシュ

`/api/*` の応答はセッションに紐づく学習データである。Worker は中継応答に
`Cache-Control: no-store` を付ける。クライアントの `fetch` にも `cache: "no-store"` を指定する。
ログアウト後や利用者が変わった後に、ブラウザキャッシュから前の学習データが
表示されるのを防ぐ。

**ゲートが守る範囲を正確に書いておく。** 後述の `run_worker_first` の通り、
`/` や `/activity` の HTML・JS は Worker を経由せず静的配信される。つまり
**アプリシェルは未認証でも取得できる。ログインが守るのは `/api/*` のデータ経路だけである。**
未認証のブラウザが `/` を開くと、データ取得は 401（`login_required`）になるが、
地図の形は Concept の定義だけで描けるので、全部が未観測の地図とログインへの導線を出す（Issue #182）。
学習データが漏れることはないが、「ログインしないと何も見えない」ではない。
アプリシェル自体を隠したくなったら `run_worker_first` に `"/"` を足して
Worker 側でリダイレクトするが、秘匿すべき情報がシェルに無い以上、現状は不要とする。

認証に必要な設定（`AUTH_ISSUER` / `AUTH_AUDIENCE` / `AUTH_CLIENT_ID` /
secret `AUTH_CLIENT_SECRET`）が欠けているときは **500 で落とす**。
「設定が無いから素通しする」は、設定漏れがそのまま認証の無効化になる。
設定漏れは機能停止として現れるべきである。`apps/api` の検証器も同じ原則で、
設定欠落を 401 ではなく 500 として返す（`auth/middleware.ts`）。

## API に追加する読み取りエンドポイント

apps/web/AGENTS.md の
「表示に必要な読み取りAPIが不足した場合は、画面固有の用途を明示して API に追加する」に従い、
画面ごとに用途とフィールドを固定する。

### 既存: `GET /v1/learning-profile`

Learning Map 画面はこれで足りる。追加不要。
返るのは `version` / `derivedAt` / `concepts[]`（`ConceptMasteryView`）/ `eventCount`。

**画面での注意。** `concepts[]` に現れない Concept は「未観測」であり、
「習熟度 0%」ではない（contract/learning-profile.ts のコメント、docs/concepts.md）。
未観測を 0% のバーとして描いてはならない。「まだ観測がありません」と文言で出す。

### `GET /v1/learning-activity`（実装済み）

**用途。** Web Viewer の「推移」画面。いつ・どの種別の学習が起きたかを日次で見る。

生ログを返さない制約があるため、サーバー側で集計した読み取りモデルにする。
イベント1件を復元できる粒度にはしない。

```ts
// apps/api/src/contract/learning-activity.ts
export const LEARNING_ACTIVITY_RESPONSE_VERSION = 1;

export interface DailyActivity {
  /** ローカル日付ではなく UTC の YYYY-MM-DD。集計の境界を一意にするため。 */
  date: string;
  /** イベント種別ごとの件数。0 件の種別はキーごと省く。 */
  counts: Partial<Record<LearningEventType, number>>;
}

export interface LearningActivityResponse {
  version: number;
  derivedAt: string;
  /** 集計対象の期間（両端を含む）。クエリの解釈結果をそのまま返す。 */
  from: string;
  to: string;
  /** 観測のある日だけを日付の昇順で並べる。空白日は行ごと省く。 */
  days: DailyActivity[];
}
```

**`days` の入力契約を固定する。**

| 入力                 | 扱い                                      |
| -------------------- | ----------------------------------------- |
| 省略                 | 30 として扱う                             |
| 1〜365 の整数        | そのまま受理                              |
| 0・負数・366 以上    | 400                                       |
| 小数・非数値・空文字 | 400                                       |
| `days` を複数回指定  | 400（先頭を採るような暗黙の解決をしない） |

範囲外を黙って丸めない。要求と結果が食い違ったまま、画面が
「30 日分」と表示しながら別の期間を描くのを防ぐ。

**期間は両端を含み、`days` は暦日数と一致させる。**

- `to` = 現在の UTC 日付
- `from` = `to` の `days - 1` 日前

`days=30` なら `from`〜`to` はちょうど 30 日になる。31 日にならない。
クライアントが 0 埋めのために生成する日付列と、API の集計範囲がこれで一致する。

- 日付境界を UTC 固定にするのは、`learning_events.occurred_at_ms` が epoch ミリ秒で、
  タイムゾーンを持たないため。表示側で必要になった時点で
  `?tz=` を足す（そのときは version を上げる必要はない。フィールド追加ではないため）。
  **実装は2段階にし、移行条件を先に決めておく。**

第1段階は `listByUser` の結果を Worker 上で畳み込む。既存の
`GET /v1/learning-profile` と同じ読み方であり、リポジトリに新しいメソッドを足さずに済む。

ただしこれは**ユーザーの全イベントを毎回メモリへ載せる**。レート制限は要求の
「頻度」を抑えるだけで、1回あたりの読み取り量は抑えない。
「問題が出るまで放置」にしないため、次を移行の条件として決めておく。

| 項目       | 内容                                                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| 移行の閾値 | 1ユーザーの `learning_events` が **10,000 件**を超えたら第2段階へ移る                                                   |
| 観測方法   | `/v1/learning-activity` の応答時に、走査した件数を `console.log` へ出す。閾値の半分（5,000 件）を超えたら警告として出す |
| 見直し時期 | 上記に達しない場合でも、Identity 導入（複数ユーザー化）の時点で必ず再評価する                                           |

第2段階では、まず**日付範囲を SQL 側へ降ろす**（`occurred_at_ms` の
`BETWEEN` で `from`〜`to` に絞る）。`idx_learning_events_user_occurred` が
そのまま効くため、これだけで走査量は要求された期間に比例する量まで落ちる。
それでも足りなければ `GROUP BY` へ移す。

```sql
-- 第2段階の集計。日付境界は UTC 固定（上述）。
SELECT strftime('%Y-%m-%d', occurred_at_ms / 1000, 'unixepoch') AS date,
       type,
       COUNT(*) AS count
  FROM learning_events
 WHERE user_id = ?1 AND occurred_at_ms BETWEEN ?2 AND ?3
 GROUP BY date, type;
```

なお `GET /v1/learning-profile` は期間で絞れない（習熟度は全履歴から導出する）ため、
この移行の対象外である。そちらが重くなった場合はスナップショットの
キャッシュを検討することになるが、docs/concepts.md の通り
イベントログが正本であることは変えない。

### 確認問題の正誤の記録先（Web/05 #77）

確認問題（Web/02 #43）の正誤は、**D1 の学習イベントとして** `POST /v1/learning-events:sync` へ記録する。
**Cloudflare KV は使わない。** KV に置くのはセッションと同意の記録だけである
（data-privacy.md「クライアント側に残るコピー」）。習熟度の正本は API Server が
学習イベントから導出するもので、Web が正誤を確定・保存すると `GET /v1/learning-profile`
が返す習熟度と画面が食い違う。

既存の同期契約で足りるため、Web 専用の書き込み口は新設していない。
実装は `apps/web/src/client/check-result.ts`。

- 2問とも正解なら `check_passed`、どちらか不正解なら `check_failed` を1件送る。
  `origin` は `"web"`、`conceptIds` は出題した Concept の1件だけ。
- 送るのは Concept と正誤だけで、**選んだ選択肢（回答内容）は送らない。**
  契約が `strictObject` なので、余計なキーを足せば受理されずに拒否が返る。
- エンベロープの `clientId` は固定値 `"web"`。Web はブラウザに識別子も残さないため、
  ブラウザごとに採番しない。同じ利用者の Web からの記録は1端末としてまとまる。
- 書き込みなので Worker の同意確認（#174）を通る。同意が無ければ `consent_required`。
- **送信に失敗しても回答操作（解説の表示・次の問題への移動）は止めない。**
  失敗は利用者へ伝え、同じイベント（同じ `id`）のまま再送できるようにする。
  再送は `duplicate` として受理されるので二重に数えられない。
  `rejected` は送信側の不具合であり、再送しても直らないためログへ理由を残す。
- 送信と学習データの削除が重なると、`accepted` に `droppedByReset: true` が付いて返る（#124）。
  削除に含まれて**記録されていない**ので、`dropped_by_reset` として記録済みと区別する。
  **再送しない。** 削除の後に送り直すと新しい記録として保存され、消したはずのデータが戻る。

`confirmed` の条件は `solvedIndependentlyCount + checkPassedCount >= 2`
（packages/domain/src/mastery.ts）なので、自力解決1回と確認問題の正解1回で `confirmed` に届く。
`apps/api/src/routes/learning-profile.test.ts` が同期から導出までを通して確かめている。

### 追加しないもの

`GET /v1/dashboard` のような合成エンドポイントは作らない。
画面が2つで、それぞれ1エンドポイントに対応している段階で BFF を挟む理由がない
（architecture.md「BFF は禁止しない。……特定の画面が安定し……た時点で」）。

## レート制限との整合

`deriveMasteryFromEvents` はリクエストごとにそのユーザーの全イベントを読み直す。
`PROFILE_RATE_LIMITER` は 30 回 / 60 秒である。

したがって次を守る。

- **1画面につきフェッチは1回。** パネルごとに `/v1/learning-profile` を叩かない。
  1回取得した `LearningProfileResponse` を、クライアント側で
  「状態別の集計」「上位 Concept」「根拠の内訳」へ分解して描く。
- 自動ポーリングを入れない。更新は明示的な再読み込みボタンに限る。
- `/v1/learning-activity` にも `PROFILE_RATE_LIMITER` を適用する
  （同じくログ全走査であるため）。

**共有であることの帰結を明記しておく。** `PROFILE_RATE_LIMITER` は
`namespace_id: 1002` の一つの枠であり、これを流用すると
**Learning Map 画面と推移画面の合計で 30 回 / 60 秒**になる。
画面を往復すると1回の遷移で2枠を消費する。それぞれ独立に 30 回ではない。
バインディングを増やさない側に倒した判断だが、実運用で足りなくなったら
`wrangler.jsonc` の `ratelimits` へ `ACTIVITY_RATE_LIMITER`（`namespace_id: 1004`。
1003 は `MASTERY_OVERRIDE_RATE_LIMITER` が使用中）を足して分離する。
そのときは `apps/api/src/app.ts` の `app.use` も1行増える。

## 画面

### 1. ログイン `/login`

Worker が Auth0 へリダイレクトする起点。画面は持たない（`auth.md` §5.3）。
認可に失敗した場合は `/login-failed` を出す。この画面は**ヘッダーの枠を出さない** —
認可に失敗した画面に「マップ / 推移 / 設定」への導線を出すと、押しても
`/api/*` が 401 を返すだけになる（`routes/__root.tsx`）。

### 2. Learning Map `/` と `/map/$language`

ブラウザから `GET /api/v1/learning-profile` と `GET /api/v1/mastery-overrides` を
フェッチして描く（Worker が `/v1/*` へ中継する）。ロジックは `learning-map.ts`
（現在地・集計）と `learning-map-view.tsx`（共有の描画）に切り離してある。

**起票時は Concept の一覧表だったが、Web/04（#53）で Skill Tree へ置き換え、
#195 で項目一覧・領域別マップ・詳細の3層へ分けた。**

- `/`: 項目一覧。領域（Concept ID のプレフィックス）ごとのカードに
  確認済み・学習中・未観測の件数と現在地バッジを出し、`/map/$language` へリンクする。
  木の定義に載らない Concept の観測は「地図に無い Concept」として下に並べる
  （見えなくすると記録が消えたように見えるため）。
- `/map/$language`: 1領域ぶんの Skill Tree。列は前提の段数、辺は `prerequisites`。
  木の定義は `packages/domain/concepts.md` が正典で、自動生成しない。
- 詳細は右のパネルへ回す。選択は `?concept=` で URL に載るため、
  共有や再読み込みで同じ詳細が開く。`status` / `score` / `evidence` の内訳、
  前提と次に接続する Concept、理解度の手動修正（Web/03 #47）。
  docs/concepts.md の意図通り、score 単独ではなく status と evidence を併記する。
- **現在地**。学習中のうち最後に観測したものを1つ選ぶ（`client/learning-map.ts`）。
  観測時刻の無い学習中は観測のあるものより後ろに回す。
  表示は現在地ノードの強調・バッジと次候補への破線で行う。独立した
  「現在地 / 次に学ぶ候補」バーは置かない（地図と詳細パネルで伝わるため）。
- 応答に無い Concept を `unobserved` として補い、全件を出す。
  **`unobserved` を 0% のバーとして描かない。**「まだ判断材料がありません。
  0% という意味ではありません」と文言で出す。
- 手動上書きは**表示だけを変え、`evidence` には触れない**。自動算出の値を
  `derived` に残し、「手動で確認済みにしたが自動算出では学習中」を区別できるようにする。
- 導出の根拠（`eventCount`・`derivedAt`）は画面に出さない。システム内部の
  情報で、利用者の判断材料にならないため（以前はフッターに出していた）。

### 2-a. 自分のマップ `/maps` と `/maps/$mapId`

Web/18（#242）。利用者が手で作った木の形のマップを `GET /api/v1/learning-maps(/:id)` で描く。
変換と読み書きは `client/learning-maps.ts`、描画は言語別マップと同じ `SkillTree` と詳細パネル。

- `/maps`: 自分のマップの一覧・作成・削除。作るのは題名と説明だけで、作ると編集画面へ移る。
  削除するとノード・「理解すること」と、そのノードで作った確認問題も消える（学習の記録は残る）。
- `/maps/$mapId/edit`: 編集画面（フォーム型、#242 のコメント 2026-10-07）。左に木のプレビュー、
  右にノードの一覧。ノードを開くと表示名・概要・前提（1つ選ぶ）・「理解すること」を直せる。
  - ノードと線は下書きに持ち（`client/map-editor.ts`）、「保存」でまとめて置き換える。
    前提は1つのノードにつき1つまで（親が1つの木。固定の言語別マップと同じ形。#242 の 2026-10-07 の決定。
    API も拒否する）。候補からは、自分と、自分を前提に辿れるノードを外す（循環させない）。
  - 「理解すること」はノードごとに別に保存する（API の口が別。保存済みのノードだけ）。
  - 既存の Concept は検索して参照で足せる（固定の一覧と、自分の他のマップのノード）。
  - 保存済みのノードを外して保存するとき、項目を外して保存するときは、確認問題も消えると確かめる。
  - 保存していない変更があるまま画面を離れようとすると止める（`useBlocker`）。
- `/maps/$mapId`: 1マップの Skill Tree。見出しはマップの題名。選択は `?concept=` で URL に載る。
  参照のノード（既存の Concept をそのまま置いたもの）は元の表示名・概要・項目を出し、
  元が消えていれば「元の Concept が見つかりません」と出す。
- 手で作ったノードの Concept ID は `<マップの ID>.<識別子>`。この形から属するマップを引き
  （`mapIdOfConcept`）、確認問題の画面の戻り先や、別の画面から選んだときの遷移先を決める。
  項目一覧の「地図に無い Concept」には並べない。
- 確認問題の画面（`/check/$conceptId`）は、手で作ったノードならそのマップから定義と
  「理解すること」を引く。技術レベルの目安はそのマップのノードで数え、領域名はマップの題名にする。
- 取り込んだマップのノードでは、確認問題の画面に「マップの問題」を分けて出す（#250）。取り込んだ版の
  公開の問題（`GET /api/v1/checks` の `mapChecks`）で、AI を使わず（回数に数えず）作り直せない。正誤は自分の組と同じく
  `check_passed` / `check_failed` として狙った項目に記録する。同じ項目に自分の組があれば自分の組だけを出す。
  Concept 単位の自動選択は自分の組だけで「作成済み」を決める（マップの問題があっても作る候補に残る）。

#### 共有と版（Web/20、#244）

持ち主の手元のマップと共有の版を分ける（2026-10-09 の決定 T1-a）。読み書きは `client/map-sharing.ts`、
中身と差分の表示は `client/map-content-view.tsx`。

- `/maps/$mapId`: 自分のマップなら手元のマップと共有の状態（範囲・版）を出し、
  「共有する」「版の履歴」へ進める。自分のマップでなければ、共有の側のいちばん新しい版
  （`GET /api/v1/shared-maps/:id`）を読むだけで出す（編集・理解度の変更・確認問題の入口は出さない）。
  「リンクだけ」の共有のリンクはこの画面に鍵を付けた `/maps/<ID>?key=<鍵>`（決定 U1）。持ち主の画面にリンクと写すボタンを出す。
  鍵が無い・合わないと持ち主以外は開けない（ノードの ID からマップ ID が分かっても開けない）。
- `/maps/$mapId/share`: 共有へ上げる前の確認画面（決定 S1-a）。範囲（リンクを知っている人だけ・全員）を選び、
  作成時の確認問題を含めるかを選ぶ。初めては出ていく中身の全部を、2回目以降は前の版との差分を先に出す。
  「この内容を共有する」で新しい版になる。確認のあとに手元が変わっていたら上げずに見せ直す。
  中身が前の版と同じなら、範囲だけを変えられる。共有をやめることもできる（版は残る）。
- `/maps/$mapId/history`: 版の履歴（新しい版から、要約付き）。中身を開いて見られ、
  過去の版に戻せる（その中身で新しい版を作り、手元のマップもその中身に戻す。履歴は書き換えない）。
- `/maps`: 自分のマップに共有中の印を出し、下に全員に共有されたマップの一覧（新しく上げた順）を出す。
  取り込んだマップには取り込み元と「更新あり」を出す。
- 取り込み（決定 T3）: 他人の共有マップの画面の「自分のマップに取り込む」で、その時点の版を自分のマップへ写す
  （ノード・項目の ID は元のまま）。取り込んだマップは自分だけのもので自由に直せる。
- フォークの公開（#246 の V1〜V5）: 取り込んだマップの「別の共有マップとして公開」で、同じ確認画面を通して
  自分が作成者の共有マップにする（元のマップは変わらない）。確認画面には、元の公開の確認問題を引き継いだうえで、
  まだ公開の問題が無いノードの問題を作る入口（AI の利用回数 5 回、マップの生成の同意を使う）を出す。
  公開したあとも元とのつながりは残り、取り込み直してからもう一度上げられる。読む人の画面には
  「もとにしたマップ」を出す（元が全員に共有されていればリンクを付ける）。
- `/maps/$mapId/reimport`: 取り込み直す前の差分（決定 T4）。共有の側にあるノードは新しい版の中身で上書き
  （自分で直したノードは先に挙げる）、自分で足したノードは残す。共有の側で消されたノードは既定で消え、
  「残す」を選ぶと自分のノードとして持ち続ける。
- 取り込んだノードの ID の前半は元のマップの ID なので、`mapIdOfConcept` で引いたマップが自分のマップでなければ、
  自分のノードの一覧（`:concepts`）から属するマップを探す（`/maps/$mapId?concept=` と確認問題の画面）。

### 2-b. 設定 `/settings`

Web/06（#123）で追加し、Issue #165 と #173 で広げた。「一般 / 使用状況 / プラン / データ」を
リンクで切り替える。**どの画面を開いているかを URL に載せる** ので、再読み込みや
共有で開いていた画面が変わらない。

| パス                | 内容                                     | 由来           |
| ------------------- | ---------------------------------------- | -------------- |
| `/settings`         | 表示名・既定の表示期間・質問履歴の保存   | Web/06 (#123)  |
| `/settings/usage`   | Managed AI の使用状況                    | #165           |
| `/settings/billing` | 現在のプラン                             | #165           |
| `/settings/data`    | 学習データと質問履歴のエクスポートと削除 | 基盤/10 (#173) |

未実装の空欄は置かない。利用者から見れば壊れているのと区別がつかない（#123）。

### 3. 推移 `/activity`

ブラウザから `GET /api/v1/learning-activity?days=<7|30|90>` を1回フェッチして描く。
日次の積み上げ棒グラフ（種別で色分け）と、期間の選択（7 / 30 / 90 日）。

**欠測日はクライアントで 0 埋めしてから描く。** `days[]` は観測のある日しか
含まないため、そのままグラフへ渡すと3日空いた2本が連日として隣り合って描かれ、
学習が途切れていないように見える。応答の `from`〜`to` から全日付を生成し、
`days[]` に無い日を件数 0 の行として補ってから描画する。
`from` / `to` を応答に含めているのはこのためである。

### 4. 質問履歴 `/history` と `/history/$conversationId`

Issue #206。「質問履歴の保存」が有効な利用者の会話を
`GET /api/v1/conversations`（一覧・メタデータのみ）と
`GET /api/v1/conversations/:id`（本文込みの詳細）で描く。正本は
`docs/conversation-history.md`。

- `/history`: 要約の一覧。先頭ページは loader が取り、「さらに読み込む」で
  `nextCursor` の続きを画面側の state へ足す。保存が無効な利用者には
  設定の「一般」への導線を出す。
- `/history/$conversationId`: 1会話の詳細。`context` / `user` / `assistant` の
  役割ラベルと時刻付きで本文を出し、1件削除を持つ。削除後は一覧へ戻り、
  loader のキャッシュも捨てる（RULE-005）。
- 「質問履歴の保存」トグルは設定の「一般」にある。有効化の文面は
  `CONVERSATION_HISTORY_OPT_IN_NOTICE`（domain）を共有して出す。
- 履歴のエクスポートと全件削除は設定の「データ」にある
  （オプトイン文面が約束する削除経路）。

## エラー表示

CLAUDE.md「エラーを握りつぶすな」。
`apps/vscode-extension` の `AIErrorReason` と同じく、**理由を区別して名前を付けて出す**。
「読み込みに失敗しました」の一種類にまとめない。

| 状況                      | 画面の表示                                                             | 追加の挙動                                      |
| ------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------- |
| 未ログイン（Cookie 無し） | `/` では未観測の地図とログイン導線、他画面ではログイン導線             | エラーとして扱わない（#182）                    |
| セッション無効 / 期限切れ | 「ログインの有効期限が切れました」                                     | `/login` へ誘導                                 |
| API が 401                | 「ログインの有効期限が切れました」                                     | KV のセッションも消してから `/login` へ誘導する |
| IdP へ到達できない（503） | 「認証サーバーに一時的に接続できません。少し待って再試行してください」 | セッションは残るので再ログインさせない          |
| API が 429                | 「短時間に要求が多すぎます。しばらく待って再読み込みしてください」     | 自動リトライしない                              |
| API が 5xx / 到達不能     | 「学習データの取得に失敗しました」                                     | 再試行ボタンを出す                              |
| ログイン試行が 429        | 「ログインの試行が多すぎます。1分ほど待ってからやり直してください」    | 自動リトライしない                              |
| データが 0 件             | 「まだ学習イベントがありません」                                       | エラーとして扱わない                            |

**共有トークンが無くなったので「API トークンが無効」という状態は存在しない。**
`apps/web/src/client/api.ts` の `ApiErrorKind` から `api_token_invalid` は消え、
現在は `login_required` / `session_expired` / `auth_unavailable` / `rate_limited` /
`consent_required` / `consent_outdated` / `unavailable` である。

種別を分けるのは、利用者の打つ手が違うからである。`session_expired` は再ログインで直り、
`auth_unavailable`（セッションは生きているが IdP が一時的に応答しない）は再試行で直り、
`login_required`（そもそも未ログイン）はエラーではない（#182）。
まとめて 401 にすると、この3つが同じ画面になる。

API が 401 を返したときは**ブラウザの Cookie を消すだけでは足りない**。KV の
セッションを残すと、同じ Cookie を持つ別の誰かが refresh を回して使い続けられる。
サーバー側を正本として先に消す（`src/worker/index.ts`）。
**ただし KV の削除は即時失効ではない**（上述の伝播遅延）。失効を早める措置であって、
保証ではない。

**ログイン直後の 401 だけは例外で、1回に限り自動リトライする。** Workers KV の
伝播遅延（上述）で正常なセッションが一時的に見つからないことがあるため。
2回目も失敗したら上表の通り表示する。それ以外の場面では自動リトライしない。

Worker 側は `apps/api/src/app.ts` の `onError` と同じ原則を採る。
例外の内容を本文へ載せない。ただし握りつぶさず、`console.error` で必ず残す。

## 技術選定

| 項目                   | 選定               | 理由                                                                                                              |
| ---------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| ランタイム             | Cloudflare Workers | `apps/api` と同じ。デプロイ経路を増やさない                                                                       |
| サーバーフレームワーク | Hono               | `apps/api` と同じ。middleware の書き方を共有できる                                                                |
| UI                     | React + Vite       | 画面が2つでも状態遷移（読込 / エラー / 空 / 表示）があり、素の DOM 操作より読める                                 |
| ルーティング           | TanStack Router    | #142 で追加。画面が増え、設定のタブを URL に載せる必要が出た。ファイル規約で `routes/` から型付きルートを生成する |
| グラフ                 | 自前の SVG         | 積み上げ棒1種類のためにライブラリを入れない                                                                       |
| テスト                 | Vitest             | 他ワークスペースと揃える                                                                                          |
| セッション保管         | Workers KV         | 撤回可能で TTL を持つ。KV namespace を1つ作る                                                                     |

React を入れる判断は `apps/desktop` の素の `renderer.js` と揃わないが、
Desktop は単一画面のオーバーレイであり、こちらは一覧とグラフを持つ。
揃えるべきは「フレームワークの名前」ではなく「状態を明示的に扱うこと」である。

## ファイル構成

```text
apps/web/
├─ package.json / tsconfig.json / eslint.config.mjs / vite.config.ts / wrangler.jsonc
├─ .dev.vars.example
├─ src/
│  ├─ worker/
│  │  ├─ index.ts            # Hono。セッション検証 → apps/api へ中継
│  │  ├─ oauth.ts            # Auth0 の認可コード交換（auth.md §5.3）
│  │  ├─ access-token.ts     # Refresh Token → Access Token。isolate 内で直列化
│  │  ├─ session.ts          # KV へのセッション発行・検証・失効
│  │  ├─ consent.ts          # 同意記録の読み書き（#174）
│  │  └─ worker-configuration.d.ts   # wrangler types の生成物
│  ├─ client/
│  │  ├─ main.tsx / api.ts / session.ts / errors.tsx / style.css
│  │  ├─ learning-map.ts        # 現在地・集計（描画なし）
│  │  ├─ learning-map-view.tsx  # Skill Tree・詳細パネルの共有描画
│  │  ├─ profile.ts / overrides.ts / activity-period.ts / ai-usage.ts
│  │  ├─ learning-data.ts / consent.ts / conversations.ts
│  │  ├─ routeTree.gen.ts       # TanStack Router の生成物（#142）
│  │  └─ routes/             # ファイル規約でルートを定義する
│  │     ├─ __root.tsx       #   枠を持たない親（/login-failed のため）
│  │     ├─ login-failed.tsx
│  │     └─ _framed/         #   ヘッダー付きの枠。URL には現れない
│  │        ├─ route.tsx
│  │        ├─ index.tsx         # 項目一覧（領域カード）
│  │        ├─ map.$language.tsx # 領域別 Skill Tree
│  │        ├─ activity.tsx
│  │        ├─ history.index.tsx            # 質問履歴の一覧
│  │        ├─ history.$conversationId.tsx  # 1会話の詳細と1件削除
│  │        └─ settings/{route,index,usage,billing,data}.tsx
│  └─ shared/               # Worker と client で共有する変換
└─ index.html
```

**描画から切り離せるロジックは切り離す。** `apps/web/AGENTS.md` の通り
jsdom も `@testing-library` も未導入で、React コンポーネントの自動テストは書けない。
検証したいロジックは `client/api.ts` や `client/learning-map.ts` のように
別ファイルへ出してから `*.test.ts` を書く。

`apps/api` 側の追加。

```text
apps/api/src/
├─ contract/learning-activity.ts       （+ .test.ts）
└─ routes/learning-activity.ts         （+ .test.ts）
```

### wrangler.jsonc

静的アセットと Worker を同一 Worker から出す。SPA なのでルーティングの取りこぼしを
`not_found_handling` で index.html へ寄せる。

```jsonc
{
  "$schema": "../../node_modules/wrangler/config-schema.json",
  "name": "gakushu-sochi-web",
  "main": "src/worker/index.ts",
  "compatibility_date": "2026-09-05",
  "observability": { "enabled": true, "head_sampling_rate": 1 },
  "assets": {
    "directory": "./dist/client",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    // Worker が先に受けるパス。それ以外は Asset Worker が静的ファイルを返す。
    // `/callback` を落とすと index.html が返り、認可コードの交換が
    // Worker に届かないまま静かに失敗する（後述の罠）。
    // `/consent` は同意記録の読み書き（#174）、`/session` はログイン状態の確認（#182）。
    "run_worker_first": ["/api/*", "/login", "/callback", "/logout", "/consent", "/session"],
  },
  "vars": {
    "API_ORIGIN": "https://gakushu-sochi-api.<account>.workers.dev",
    // Auth0 の issuer。OIDC Discovery が返す値をそのまま置く（末尾スラッシュ必須）。
    "AUTH_ISSUER": "https://<tenant>.auth0.com/",
    // API の audience。指定しないと API 向けでないトークンが返る（auth.md §4）。
    "AUTH_AUDIENCE": "https://api.gakushu-sochi.dev",
    // confidential client の client_id は秘密ではないのでここに置く（auth.md §5）。
    "AUTH_CLIENT_ID": "<Auth0 で発行された値>",
  },
  "secrets": { "required": ["AUTH_CLIENT_SECRET"] },
  "kv_namespaces": [{ "binding": "SESSIONS", "id": "<作成後に埋める>" }],
  // 認証前エンドポイント（/login と /callback）への到達を数える。
  "ratelimits": [
    {
      "name": "LOGIN_RATE_LIMITER",
      "namespace_id": "2001",
      "simple": { "limit": 20, "period": 60 },
    },
  ],
}
```

`apps/api` 側は CORS を開けない。同一生成元で完結するため
`CORS_ALLOWED_ORIGINS` は `""` のままにする。開ける必要が出たら、
それは案 A から外れたということなので設計を見直す合図とする。

### ルートの package.json（配線済み）

`compile` / `test` / `test:unit` / `lint` / `check:worker-types` / `dev` は
ワークスペースを名指しで列挙しており、すべてに `@gakushu-sochi/web` が入っている。
`dev` は `--names api,desktop,web` と名前・順序を揃えている
（`test/package-scripts.test.mjs` がその形を検査する）。

## 積み残し（本 Issue の範囲外）

- ~~Identity（OAuth / OIDC）。~~ Auth/05（#84）で実装した。`/login` は Auth0 への
  リダイレクト起点になり、KV セッションは Refresh Token を保持する。
  **予告どおり中継の形は変わっていない**（`/api/*` → `/v1/*`、Cookie だけをブラウザへ）。
  共有トークンは Auth/06（#85）で削除した。
- ~~ユーザー設定の編集。~~ Web/06（#123）で `/settings` として実装した。
  設定は D1 の `user_settings` に置く。1ユーザー1行の上書きで、退会の
  `DELETE FROM users` が `ON DELETE CASCADE` で一緒に消す。
- ~~データのエクスポート / 削除の画面。~~ 基盤/10（#173）で `/settings/data` として実装した
  （`GET /v1/learning-events:export` / `DELETE /v1/learning-events`、
  data-privacy.md「保存期間と削除」）。
- 確認問題（Web/02 #43）。出題形式の正典は #43、生成は Web/07（#184）、
  生成した問題の保存は Web/08（#185）、正誤の記録は Web/05（#77）が持つ。
