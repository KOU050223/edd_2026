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
   * 確認問題の生成（#184）は、保存して使い回すキャッシュ（#185）とセットで公開する。
   * キャッシュの振る舞いは `routes/checks.test.ts` が固定している。
   */
  test("確認問題の生成をキャッシュとセットで公開する", () => {
    expect(app.routes).toContainEqual(
      expect.objectContaining({ method: "POST", path: "/v1/checks:generate" }),
    );
  });
});
