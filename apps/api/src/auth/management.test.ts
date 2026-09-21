/**
 * Auth0 Management API 側（退会の後半）の検証。
 *
 * 順序そのものは `routes/account.test.ts` が固定する。ここで見るのは
 * 「設定の欠落を素通りさせないこと」と「失敗を成功に丸めないこと」。
 */

import { describe, expect, it, vi } from "vitest";
import {
  createManagementUsers,
  ManagementConfigurationError,
  ManagementRequestError,
} from "./management.js";

const CONFIG = {
  issuer: "https://example.auth0.com/",
  clientId: "management-client",
  clientSecret: "management-secret",
};

/** トークン取得に成功し、続く削除で `status` を返す fetch。 */
function fetchReturning(status: number, body: string | null = null) {
  return (
    vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "management-token" })))
      // 204 は本文を持てないので、本文を渡すかどうかは呼び出し側が決める。
      .mockResolvedValueOnce(new Response(body, { status }))
  );
}

describe("createManagementUsers", () => {
  it("設定が欠けていたら組み立てずに落とす", () => {
    // 「設定が無いから何もしない」にすると、退会が D1 だけ消して成功を返し、
    // IdP にユーザーが残っていることを誰も知らないまま進む。
    for (const missing of ["issuer", "clientId", "clientSecret"] as const) {
      expect(() =>
        createManagementUsers({ ...CONFIG, [missing]: undefined, fetch: vi.fn() }),
      ).toThrow(ManagementConfigurationError);
    }
  });

  it("issuer が https でなければ落とす", () => {
    // Management API のトークンは全ユーザーを消せる資格情報であり、
    // 平文 HTTP の相手へ送ってよいものではない（RULE-003）。
    expect(() =>
      createManagementUsers({ ...CONFIG, issuer: "http://example.auth0.com", fetch: vi.fn() }),
    ).toThrow(ManagementConfigurationError);
  });
});

describe("Auth0 のユーザー削除", () => {
  it("sub をエスケープしてトークン付きで削除する", async () => {
    const fetchMock = fetchReturning(204);

    await createManagementUsers({ ...CONFIG, fetch: fetchMock as unknown as typeof fetch }).delete(
      "auth0|user-a",
    );

    const [tokenUrl] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(tokenUrl).toBe("https://example.auth0.com/oauth/token");

    const [deleteUrl, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    // `sub` は `|` を含む。エンコードしないとパスが壊れる。
    expect(deleteUrl).toBe("https://example.auth0.com/api/v2/users/auth0%7Cuser-a");
    expect(init.method).toBe("DELETE");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer management-token");
    // 資格情報を載せるのでリダイレクトを追跡しない（RULE-002）。
    expect(init.redirect).toBe("error");
    // 応答が返らないまま待ち続けない（RULE-001）。
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("既に居ないユーザー（404）は達成済みとして扱う", async () => {
    // 前回の退会が Auth0 まで通っていた場合の再実行がこれに当たる。
    const fetchMock = fetchReturning(404);

    await expect(
      createManagementUsers({ ...CONFIG, fetch: fetchMock as unknown as typeof fetch }).delete(
        "auth0|user-a",
      ),
    ).resolves.toBeUndefined();
  });

  it("2xx 以外を成功に丸めない", async () => {
    const fetchMock = fetchReturning(500, "upstream failure");

    await expect(
      createManagementUsers({ ...CONFIG, fetch: fetchMock as unknown as typeof fetch }).delete(
        "auth0|user-a",
      ),
    ).rejects.toBeInstanceOf(ManagementRequestError);
  });

  it("トークン応答が 2xx でも解析できなければ失敗として扱う", async () => {
    // 2xx でも本文の解析に失敗したなら、それは失敗である（RULE-004）。
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("not json"));

    await expect(
      createManagementUsers({ ...CONFIG, fetch: fetchMock as unknown as typeof fetch }).delete(
        "auth0|user-a",
      ),
    ).rejects.toBeInstanceOf(ManagementRequestError);
    // 削除まで進まない。トークンが取れていないのに消しに行かない。
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("トークン応答に access_token が無ければ失敗として扱う", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ scope: "x" })));

    await expect(
      createManagementUsers({ ...CONFIG, fetch: fetchMock as unknown as typeof fetch }).delete(
        "auth0|user-a",
      ),
    ).rejects.toBeInstanceOf(ManagementRequestError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
