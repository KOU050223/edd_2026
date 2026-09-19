# 自動テストガイド

自動テストの**方針**と**書き方・動かし方**をまとめる。

手動での動作確認手順は [`testing.md`](testing.md) にある。本ドキュメントは重複させず、
自動テストだけを扱う。

---

## 1. 何を自動テストにするか

**判定・変換・契約を自動テストにする。見た目と実機依存は手動に残す。**

| 対象                                                           | 扱い |
| -------------------------------------------------------------- | ---- |
| 純粋な判定・導出（習熟度の規則、ストリームの解析、URL の検証） | 自動 |
| HTTP の契約（ステータス、エラー種別、冪等性、認証の拒否）      | 自動 |
| 失敗時の分岐（2xx でも解析に失敗した、401 の理由が違う）       | 自動 |
| キーバインド、VS Code の UI、Electron の実ウィンドウ、OS 差分  | 手動 |
| レイアウト・配色・フォント                                     | 手動 |

迷ったら次で切る。**壊れたときに CI で気付きたいなら自動、目で見ないと分からないなら手動。**

外部サービス（Cloudflare、AI プロバイダ、VS Code 本体）は自動テストで起動しない。
境界は差し替え可能にして、テストでは偽物を渡す（§6）。

### Definition of Done

ロジックを変更する Issue / PR は、**実装と同じ PR でテストまで終わらせる**。
振る舞いが変わったのにテストが 1 行も変わらない PR は、レビューで理由を聞かれる。

---

## 2. 実行方法

すべてリポジトリルートから実行する。

```bash
npm test          # 全部。メタテスト → compile → 各ワークスペースの単体テスト
npm run test:unit # 上から package-scripts の検査だけを省いたもの（project-rules と compile は走る）
```

ワークスペースを 1 つに絞る場合は `--workspace` を使う。

```bash
npm run test:unit --workspace=@gakushu-sochi/domain
npm run test:unit --workspace=@gakushu-sochi/api
npm run test:unit --workspace=@gakushu-sochi/web
npm run test:unit --workspace=@gakushu-sochi/desktop
npm run test:unit --workspace=gakushu-sochi          # VS Code 拡張（名前に注意）
```

テスト名で絞り込むときは `--` を挟んで vitest へ渡す。

```bash
npm run test:unit --workspace=@gakushu-sochi/domain -- -t "イベントが無ければ"
```

`npm` では `--` 以降が実行コマンドへ追記される（`vitest run src -t "..."` になる）。
pnpm の流儀とは逆なので、他プロジェクトの手順をそのまま持ち込まない。

実装中は watch を使う。`apps/desktop` にだけ `test:watch` が無いので、
そこはワークスペースのディレクトリで `npx vitest` を直接叩く。

```bash
npm run test:watch --workspace=@gakushu-sochi/api
```

### push する前に

pre-push で落ちないよう、手元でも同じものを流す。テストだけ通して push すると
lint / format や生成物の検査で落ちる。

```bash
npm run format:check && npm run lint && npm run compile && \
  npm run check:concepts && npm run check:worker-types && npm run build:web && npm test
```

pre-commit（format / lint / compile）と pre-push（生成物の検査 + テスト一式）は
lefthook が自動で走らせる。CI 成功後のデプロイは API と Web で分離している。
配線は [`lefthook.yml`](../lefthook.yml)、[`.github/workflows/ci.yml`](../.github/workflows/ci.yml)、
[`.github/workflows/deploy-api.yml`](../.github/workflows/deploy-api.yml)、
[`.github/workflows/deploy-web.yml`](../.github/workflows/deploy-web.yml)。

---

## 3. テストの置き場所

**テスト対象と同じディレクトリに `*.test.ts` を置く。**

```text
packages/domain/src/
├─ mastery.ts
└─ mastery.test.ts      ← 同じ場所

apps/api/src/routes/
├─ learning-events.ts
└─ learning-events.test.ts
```

**例外: `apps/vscode-extension` の拡張全体の結線テストとマニフェスト検査は `src/test/` に置く。**
それ以外は対象実装と併置する。

`apps/desktop` だけ `vitest.config.ts` で `src/**/*.test.ts` を拾い、
残りは `vitest run src` のように npm script の引数で範囲を決めている。
どちらもこの命名なら設定を触らずに認識される。

---

## 4. テストの書き方

### 基本の形

`describe` で包まず、`test()` を並べる。テスト名は日本語で書く。

```ts
import { expect, test } from "vitest";
import { deriveMasteryFromEvents } from "./mastery.js";

test("イベントが無ければ習熟度のキー自体が生まれない", () => {
  expect(deriveMasteryFromEvents([])).toEqual({});
});
```

import は明示する。`globals` を有効にしていないので、省略すると動かない。
ワークスペース内の相対 import には `.js` 拡張子を付ける（`apps/vscode-extension` を除く）。

**例外: `apps/desktop` は `describe` / `it` と英語名で書かれている。**
そのワークスペースへ足すときは既存に合わせる。**既存のテストを揃えるためだけに書き換えない。**

### Arrange / Act / Assert

前提・実行・検証を空行で区切る。`// Arrange` のようなコメントは要らない。

```ts
test("同じConceptIdが重複していても1回だけ畳み込む", () => {
  const events = [event("e1", "2026-09-05T00:00:01.000Z", "solved_independently")];
  events[0]!.conceptIds = ["go.defer", "go.defer"];

  const mastery = deriveMasteryFromEvents(events)["go.defer"];

  expect(mastery?.evidence.solvedIndependentlyCount).toBe(1);
  expect(mastery?.score).toBe(0.25);
});
```

Act と Assert を 1 つの式へ潰さない。何を渡すと何が返るのかが折り返しに埋もれる。

後片付けは `afterEach` へ寄せる。テスト末尾に書くと、assertion が失敗した時点で
到達せず、後片付けが実行されない。

```ts
afterEach(() => {
  vi.unstubAllGlobals();
});
```

---

## 5. テスト名は「保証したい動作」を書く

**何をしたら、どうなるべきか**が読み取れる形にする。判定基準は 1 つ。

> **関数名を変えたら / 実装を差し替えたら名前が嘘になるなら、それは実装の名前になっている。**

```ts
// NG: 実装の名前
test("deriveMasteryFromEvents が {} を返す"); // 関数名を変えたら嘘になる
test("syncEvent が fetch を呼ぶ"); // 呼ばれても同期が失敗していれば意味がない

// OK: 保証したい動作
test("イベントが無ければ習熟度のキー自体が生まれない");
test("モデル選択に失敗したときは例外ではなく失敗応答を返す");
test("API の 401 理由を利用者が取れるエラー種別へ写像する");
```

`LearningEvent` / `習熟度` / `401` のようなドメインの言葉は実装名ではないので書いてよい。
禁止するのはライブラリ名・内部関数名・変数名、および「〜が呼ばれる」という
**実装の呼び出しを主語にした書き方**。

「〜が呼ばれる」が特に問題なのは、**呼ばれたことを保証しても、その結果利用者が
何を得られるかを保証していない**ため。テストが通ったまま機能が壊れる余地が残る。

---

## 6. 外部依存の差し替え

実物を起動せず、境界に偽物を渡す。このリポジトリで使う手は 3 つだけ。

### fetch — `vi.stubGlobal`

外向きの HTTP は `fetch` を差し替える。`afterEach` で必ず戻す。

```ts
import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
});

test("2xx でも本文の解析に失敗したら失敗として扱う", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("not-json", { status: 200 })),
  );

  const outcome = await syncEvent(EVENT, CONFIG);

  expect(outcome.ok).toBe(false);
});
```

### コールバック — `vi.fn`

呼ばれたことではなく、**呼ばれた結果渡された値**を検証する。

```ts
const chunks: string[] = [];

parseOpenAIStream(payload, (chunk) => chunks.push(chunk));

expect(chunks).toEqual(["こんにちは", "！"]);
```

### モジュール — `vi.mock`

`vscode` のように import 自体が実環境を要求するものだけに使う。
`vi.mock` は巻き上げられるため、モックが変数を参照するなら `vi.hoisted` で作る
（`apps/vscode-extension/src/ai/vscode-lm.test.ts` が見本）。

```ts
const { selectChatModels } = vi.hoisted(() => ({ selectChatModels: vi.fn() }));

vi.mock("vscode", () => ({ lm: { selectChatModels } }));
```

参照するだけで中身が要らないなら `vi.mock("vscode", () => ({}))` で足りる。

### API のルート — In-Memory リポジトリ

`apps/api` は D1 を起動しない。ルートを生成する関数へ In-Memory 実装を渡し、
`new Hono()` に載せて `app.request()` で叩く。`now` も注入して時刻を固定する。

```ts
beforeEach(() => {
  events = new InMemoryLearningEventRepository();
  app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
  app.use("/v1/*", devAuth);
  app.route(
    "/v1",
    createLearningEventsRoute(() => ({ identity, events, now: () => 1000 })),
  );
});
```

**実装から `Date.now()` や `Math.random()` を直接呼ばない。** 注入できないと固定できず、
時刻や乱数に依存した Flaky Test になる。

### 実時間を待たない

`setTimeout` や `await sleep(500)` をテストへ書かない。実行が遅くなり CI で Flaky になる。
待ちが要るなら、待つ対象を注入可能にして偽物を解決する。

---

## 7. 境界値を必ず書く

幅・しきい値を持つ仕様は、**両端とその外側**を書く。中央値だけのテストは、
境界をずらすリグレッションを検知できない。

習熟度のしきい値、レート制限の回数、受付期間などが該当する。
同じ関数へ値を変えて渡すだけのケースが 3 件以上並ぶなら `it.each` / `test.each` の表にしてよい
（現状このリポジトリに使用例は無い）。

---

## 8. 失敗の扱い

[`.agents/rules/rules.md`](../.agents/rules/rules.md) の RULE-004「エラーを握りつぶすな」は
テストにも効く。**成功系だけのテストは未完成。**

- 失敗したときに**呼び出し側が失敗と判別できる**ことを検証する（`ok: false`、エラー種別）。
- 「例外を投げずに済ませた」ことを成功として検証しない。黙って既定値へ落ちる実装は、
  テストが緑のまま壊れる。
- 2xx でも本文の解析に失敗したなら、それは失敗である（RULE-004 の 3 番）。

---

## 9. バグを直すとき

1. バグを再現するテストを書く
2. **失敗することを確認する**
3. 直す
4. 通ることを確認する

手順 2 を飛ばすと、そのテストが本当にそのバグを捕まえているか分からない。

---

## 10. ワークスペース横断のメタテスト

単体テストとは別に、リポジトリ全体の規約を検査するテストがある。

```bash
npm run test:package-scripts   # package scripts / CI / hook の配線
npm run test:project-rules     # PR レビュー由来のプロジェクトルール
```

どちらも `npm test` から呼ばれ、CI と lefthook にも配線済み。通常は個別実行しない。
ルールの一覧は [`.agents/rules/rules.md`](../.agents/rules/rules.md)、
運用方針は [`guardrails.md`](guardrails.md) を参照。

**ルールを増やすのは人間の判断。** 収穫と提示までが機械の仕事なので、
このガイドに書いた助言を勝手に `rules.md` へ昇格させない。

---

## 11. まだ整備していないもの

書く前に、まず土台を入れる Issue を立てること。**無いものを有るかのように書かない。**

- **React コンポーネントのテスト**: jsdom も `@testing-library` も未導入。
  `apps/web` の自動テストは `client/api.ts`・`client/profile.ts` と Worker に限る。
  表示の確認は手動。
- **VS Code 本体を要する E2E**: 未導入。拡張の確認は [`testing.md`](testing.md) の手順で行う。
- **Electron の実ウィンドウを要するテスト**: 未導入。`apps/desktop` は main / renderer の
  純粋な関数だけを単体テストしている。
