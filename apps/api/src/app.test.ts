import { describe, expect, test } from "vitest";
import { app } from "./app";

describe("API Worker", () => {
  test("GET /health はサービス状態を返す", async () => {
    const response = await app.request("https://api.example.test/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  test("退会用DELETEをCORSのpreflightで許可する", async () => {
    const response = await app.request(
      "https://api.example.test/v1/me",
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://web.example.test",
          "Access-Control-Request-Method": "DELETE",
        },
      },
      { CORS_ALLOWED_ORIGINS: "https://web.example.test" } as CloudflareBindings,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toContain("DELETE");
  });

  /**
   * 確認問題の生成（#184）は、保存して使い回すキャッシュ（#185）とセットでのみ有効になる。
   *
   * 歯止めの本体は「保存済みがあれば生成しない」であり、それを実装するのは #185 である。
   * 生成だけを先に公開すると、`ai_usage` の回数上限の外で毎回生成が走る経路が開く。
   * **#185 でここへ繋ぐときは、キャッシュの確認と同時に行い、このテストを書き換える。**
   */
  test("確認問題の生成はキャッシュ（#185）とセットになるまで公開しない", () => {
    expect(app.routes.map((route) => route.path)).not.toContain("/v1/checks:generate");
  });
});
