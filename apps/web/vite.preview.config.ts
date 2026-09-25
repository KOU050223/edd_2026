/**
 * 目で確かめるためだけの dev サーバー。**ビルドにもデプロイにも入らない。**
 *
 * `npm run dev` は Auth0 の `.dev.vars` と apps/api が要る。地図の見た目を確かめたいだけの
 * ときにその 2 つを揃えるのは重いので、`/session` と `/api/v1/*` に標本の応答を返す
 * ミドルウェアを挟んで、クライアントだけを動かす。
 *
 *     npx vite --config vite.preview.config.ts
 *
 * 認証・中継・KV は通らないので、**これで確かめられるのは画面だけである。**
 * 認証やデータ経路の確認には使えない。
 */

import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

interface SampleConcept {
  conceptId: string;
  /** 表示名。実 API も `label` を返す（apps/api/src/contract/learning-profile.ts）。 */
  label: string;
  status: "confirmed" | "learning" | "unobserved";
  score: number;
  evidence: {
    solvedIndependentlyCount: number;
    hintUsedCount: number;
    lastObservedAt?: string;
  };
}

const observed = (
  conceptId: string,
  label: string,
  status: SampleConcept["status"],
  score: number,
  solved: number,
  hints: number,
  lastObservedAt: string,
): SampleConcept => ({
  conceptId,
  label,
  status,
  score,
  evidence: { solvedIndependentlyCount: solved, hintUsedCount: hints, lastObservedAt },
});

/**
 * TypeScript を主に触っていて、Git と HTTP に少し手を出した学習者。
 *
 * 応答は観測のある Concept だけを返す（未観測を 0 で埋めない契約）。
 * 残り 133 件はクライアントが定義から補う。
 */
const SAMPLE_CONCEPTS: SampleConcept[] = [
  observed(
    "ts.variable_declaration",
    "変数宣言と const / let",
    "confirmed",
    0.92,
    6,
    0,
    "2026-09-10T02:10:00.000Z",
  ),
  observed(
    "ts.primitive_types",
    "プリミティブ型と値",
    "confirmed",
    0.88,
    5,
    1,
    "2026-09-11T05:20:00.000Z",
  ),
  observed(
    "ts.control_flow",
    "if / switch / ループ",
    "confirmed",
    0.85,
    4,
    1,
    "2026-09-12T01:40:00.000Z",
  ),
  observed(
    "ts.function_basics",
    "関数宣言と引数・戻り値",
    "confirmed",
    0.83,
    5,
    2,
    "2026-09-15T03:05:00.000Z",
  ),
  observed(
    "ts.object_basics",
    "オブジェクトとプロパティ",
    "confirmed",
    0.79,
    3,
    1,
    "2026-09-16T06:30:00.000Z",
  ),
  observed(
    "ts.array_basics",
    "配列の生成と要素アクセス",
    "confirmed",
    0.81,
    4,
    1,
    "2026-09-17T02:55:00.000Z",
  ),
  observed(
    "ts.type_annotation",
    "型注釈と型推論",
    "confirmed",
    0.76,
    3,
    2,
    "2026-09-18T07:15:00.000Z",
  ),
  observed(
    "ts.array_methods",
    "map / filter / reduce",
    "confirmed",
    0.74,
    3,
    2,
    "2026-09-19T04:45:00.000Z",
  ),
  observed(
    "ts.interface_basics",
    "interface とオブジェクト型",
    "learning",
    0.35,
    1,
    3,
    "2026-09-22T08:00:00.000Z",
  ),
  // 現在地。学習中のうち最後に観測したものが選ばれる。
  observed(
    "ts.promise_basics",
    "Promise と状態遷移",
    "learning",
    0.4,
    3,
    2,
    "2026-09-25T09:12:00.000Z",
  ),
  observed(
    "git.repository",
    "init / clone とリポジトリ",
    "confirmed",
    0.9,
    4,
    0,
    "2026-09-08T01:00:00.000Z",
  ),
  observed(
    "git.staging",
    "add とステージング",
    "confirmed",
    0.86,
    5,
    0,
    "2026-09-08T02:00:00.000Z",
  ),
  observed(
    "git.commit",
    "コミットとメッセージ",
    "confirmed",
    0.84,
    6,
    1,
    "2026-09-09T02:30:00.000Z",
  ),
  observed("git.branch", "ブランチと切り替え", "learning", 0.3, 1, 2, "2026-09-20T05:00:00.000Z"),
  observed(
    "http.request_response",
    "リクエストとレスポンスの構造",
    "confirmed",
    0.72,
    2,
    1,
    "2026-09-14T03:20:00.000Z",
  ),
  // HTTP は全 7 件を確認済みにしてある。コンプリートの表示を確かめるため。
  observed(
    "http.method_semantics",
    "GET / POST などメソッドの意味",
    "confirmed",
    0.78,
    3,
    0,
    "2026-09-14T04:00:00.000Z",
  ),
  observed(
    "http.status_code",
    "ステータスコードの区分",
    "confirmed",
    0.8,
    3,
    1,
    "2026-09-15T01:00:00.000Z",
  ),
  observed(
    "http.header",
    "ヘッダと Content-Type",
    "confirmed",
    0.75,
    2,
    1,
    "2026-09-16T02:00:00.000Z",
  ),
  observed("http.rest", "REST のリソース指向", "confirmed", 0.73, 2, 2, "2026-09-18T05:00:00.000Z"),
  observed("http.cors", "CORS とオリジン", "confirmed", 0.71, 2, 3, "2026-09-19T06:00:00.000Z"),
  observed(
    "http.auth",
    "認証ヘッダとトークン",
    "confirmed",
    0.77,
    3,
    1,
    "2026-09-21T07:00:00.000Z",
  ),
];

const PROFILE = {
  version: 1,
  derivedAt: "2026-09-25T09:12:00.000Z",
  eventCount: 1284,
  concepts: SAMPLE_CONCEPTS,
};

/** 手動上書き。PUT を受けるとこの場で書き換わるので、保存の往復も確かめられる。 */
const overrides: Record<string, { status: string; updatedAt: string }> = {};

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function sampleApi(): Plugin {
  return {
    name: "sample-api",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? "").split("?")[0];
        const json = (body: unknown, status = 200) => {
          response.statusCode = status;
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify(body));
        };
        if (path === "/session") return json({ loggedIn: true });
        if (path === "/api/v1/learning-profile") return json(PROFILE);
        if (path === "/api/v1/mastery-overrides") {
          if (request.method !== "PUT") return json(overrides);
          void handleOverridePut(request, response, json);
          return;
        }
        if (path === "/api/v1/user-settings") return json({ activityPeriodDays: 30 });
        // プレビュー専用。達成の記録を消して、初回の祝い表示をもう一度出せるようにする。
        // 本番の API にこの経路は無い。
        if (path === "/api/__preview/reset-completions") {
          completions.length = 0;
          return json({ ok: true });
        }
        if (path === "/api/v1/area-completions:check") {
          if (request.method !== "POST") return json({ error: "unavailable" }, 405);
          void handleCompletionCheck(json);
          return;
        }
        // 標本を用意していない経路を 200 で誤魔化さない。何が足りないかを画面に出す。
        if (path.startsWith("/api/")) return json({ error: "unavailable" }, 501);
        next();
      });
    },
  };
}

async function handleOverridePut(
  request: IncomingMessage,
  response: ServerResponse,
  json: (body: unknown, status?: number) => void,
) {
  try {
    const payload = JSON.parse(await readBody(request)) as {
      conceptId?: string;
      status?: string | null;
    };
    if (typeof payload.conceptId !== "string") return json({ error: "unavailable" }, 400);
    if (payload.status === null || payload.status === undefined)
      delete overrides[payload.conceptId];
    else
      overrides[payload.conceptId] = {
        status: payload.status,
        updatedAt: "2026-09-25T09:30:00.000Z",
      };
    json(overrides);
  } catch (error: unknown) {
    // 失敗を握りつぶさない（RULE-004）。標本側の壊れ方も画面に出す。
    console.error("標本 API の PUT が壊れた", error);
    json({ error: "unavailable" }, 500);
  }
}

/** Concept の全 ID。生成物から読む（domain は CommonJS なので import しない）。 */
const CONCEPT_IDS = [
  ...readFileSync(
    new URL("../../packages/domain/src/concepts.generated.ts", import.meta.url),
    "utf8",
  ).matchAll(/id: "([^"]+)"/g),
].map((match) => match[1] ?? "");

/** 標本の達成記録。判定は本番と同じく「その分野の Concept が全件 確認済みか」。 */
const completions: { language: string; completedAt: string }[] = [];

function handleCompletionCheck(json: (body: unknown, status?: number) => void) {
  const confirmed = new Set(
    SAMPLE_CONCEPTS.filter((concept) => concept.status === "confirmed").map(
      (concept) => concept.conceptId,
    ),
  );
  for (const [conceptId, override] of Object.entries(overrides)) {
    if (override.status === "confirmed") confirmed.add(conceptId);
    else confirmed.delete(conceptId);
  }
  const total = new Map<string, number>();
  const done = new Map<string, number>();
  for (const concept of CONCEPT_IDS) {
    const language = concept.split(".")[0] ?? "";
    total.set(language, (total.get(language) ?? 0) + 1);
    if (confirmed.has(concept)) done.set(language, (done.get(language) ?? 0) + 1);
  }
  const known = new Set(completions.map((completion) => completion.language));
  const newlyCompleted: string[] = [];
  for (const [language, count] of total) {
    if (done.get(language) === count && !known.has(language)) {
      newlyCompleted.push(language);
      completions.push({ language, completedAt: "2026-09-26T00:10:00.000Z" });
    }
  }
  json({ version: 1, completions, newlyCompleted });
}

export default defineConfig({
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      routesDirectory: "./src/client/routes",
      generatedRouteTree: "./src/client/routeTree.gen.ts",
    }),
    react(),
    sampleApi(),
  ],
  // `@gakushu-sochi/domain` は CommonJS で、`file:` 依存なので Vite の
  // 事前バンドルから外れる。外れたままだと dev サーバーが名前付き export を
  // 解決できず（`CONSENT_NOTICE_VERSION` が無い、と言って画面が真っ白になる）、
  // 本番のビルド経路（`vite build`）とだけ挙動が食い違う。明示して取り込む。
  optimizeDeps: { include: ["@gakushu-sochi/domain"] },
  server: { port: 5178 },
});
