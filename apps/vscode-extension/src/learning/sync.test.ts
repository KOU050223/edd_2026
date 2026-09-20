import { afterEach, expect, test, vi } from "vitest";
import type { LearningEvent } from "@gakushu-sochi/domain";
import { syncEvent } from "./sync";

const EVENT: LearningEvent = {
  id: "event-1",
  occurredAt: "2026-09-06T00:00:00.000Z",
  type: "hint_used",
  origin: "vscode",
  conceptIds: ["go.defer"],
};

const CONFIG = {
  apiBaseUrl: "https://api.example.com",
  apiToken: async () => "test-token",
  clientId: "client-1",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

test("トークン取得に失敗したら送らずに再ログインを案内する", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  const outcome = await syncEvent(EVENT, { ...CONFIG, apiToken: async () => "" });

  expect(outcome).toEqual({ ok: false, reason: "再ログインが必要です" });
  expect(fetchMock).not.toHaveBeenCalled();
});

test("トークン取得後に同意が取り消されたらfetchしない", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  let canSend = true;

  const outcome = await syncEvent(EVENT, {
    ...CONFIG,
    apiToken: async () => {
      canSend = false;
      return "test-token";
    },
    canSend: () => canSend,
  });

  expect(outcome).toEqual({ ok: false, reason: "送信の同意が取り消されました" });
  expect(fetchMock).not.toHaveBeenCalled();
});

test("受理されたら status: accepted を返す", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [{ status: "accepted" }] }), {
        status: 200,
      }),
    ),
  );

  const outcome = await syncEvent(EVENT, CONFIG);

  expect(outcome).toEqual({ ok: true, status: "accepted", reason: undefined });
});

test("正しいURL・ヘッダー・ボディでPOSTする", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ results: [{ status: "accepted" }] })));
  vi.stubGlobal("fetch", fetchMock);

  await syncEvent(EVENT, CONFIG);

  expect(fetchMock).toHaveBeenCalledWith(
    "https://api.example.com/v1/learning-events:sync",
    expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        "content-type": "application/json",
        authorization: "Bearer test-token",
      }),
    }),
  );
  const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
  expect(body).toEqual({ clientId: "client-1", events: [EVENT] });
});

test("末尾のスラッシュがあっても二重にならない", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ results: [{ status: "accepted" }] })));
  vi.stubGlobal("fetch", fetchMock);

  await syncEvent(EVENT, { ...CONFIG, apiBaseUrl: "https://api.example.com/" });

  expect(fetchMock).toHaveBeenCalledWith(
    "https://api.example.com/v1/learning-events:sync",
    expect.anything(),
  );
});

test("HTTPエラーなら理由付きで失敗を返す", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));

  const outcome = await syncEvent(EVENT, CONFIG);

  expect(outcome).toEqual({ ok: false, reason: "HTTP 500" });
});

test("認証切れの401なら再ログインを案内する", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));

  const outcome = await syncEvent(EVENT, CONFIG);

  expect(outcome).toEqual({ ok: false, reason: "再ログインが必要です" });
});

test("ネットワークエラーなら例外を投げず失敗を返す", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

  const outcome = await syncEvent(EVENT, CONFIG);

  expect(outcome.ok).toBe(false);
  expect((outcome as { reason: string }).reason).toContain("fetch failed");
});

test("認証エラーならネットワークエラーではなく再ログインを案内する", async () => {
  const outcome = await syncEvent(EVENT, {
    ...CONFIG,
    apiToken: async () => {
      throw new Error("再ログインが必要です");
    },
  });

  expect(outcome).toEqual({ ok: false, reason: "再ログインが必要です" });
});

test("重複ならstatus: duplicateと理由を返す", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ results: [{ status: "duplicate", reason: undefined }] })),
      ),
  );

  const outcome = await syncEvent(EVENT, CONFIG);

  expect(outcome).toEqual({ ok: true, status: "duplicate", reason: undefined });
});

test("resultsが空ならサーバー不整合として失敗を返す", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [] }))));

  const outcome = await syncEvent(EVENT, CONFIG);

  expect(outcome.ok).toBe(false);
});

test("httpのリモートURLはトークンを送らずに拒否する", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  const outcome = await syncEvent(EVENT, { ...CONFIG, apiBaseUrl: "http://api.example.com" });

  expect(outcome).toEqual({ ok: false, reason: expect.stringContaining("安全ではありません") });
  expect(fetchMock).not.toHaveBeenCalled();
});

test("ローカル開発のhttpは許可する", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ results: [{ status: "accepted" }] })));
  vi.stubGlobal("fetch", fetchMock);

  const outcome = await syncEvent(EVENT, { ...CONFIG, apiBaseUrl: "http://localhost:8787" });

  expect(outcome).toEqual({ ok: true, status: "accepted", reason: undefined });
  expect(fetchMock).toHaveBeenCalledWith(
    "http://localhost:8787/v1/learning-events:sync",
    expect.anything(),
  );
});

test("URLとして壊れていれば送らない", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  const outcome = await syncEvent(EVENT, { ...CONFIG, apiBaseUrl: "not a URL" });

  expect(outcome.ok).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("リダイレクトを追跡せずタイムアウトを設定する", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ results: [{ status: "accepted" }] })));
  vi.stubGlobal("fetch", fetchMock);

  await syncEvent(EVENT, CONFIG);

  const init = fetchMock.mock.calls[0][1] as RequestInit;
  expect(init.redirect).toBe("error");
  expect(init.signal).toBeInstanceOf(AbortSignal);
});

test("応答本文が壊れていても例外にせず失敗を返す", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json", { status: 200 })));

  const outcome = await syncEvent(EVENT, CONFIG);

  expect(outcome.ok).toBe(false);
});

test("resultsが配列でなければ失敗を返す", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: null }), { status: 200 })),
  );

  const outcome = await syncEvent(EVENT, CONFIG);

  expect(outcome).toEqual({ ok: false, reason: expect.stringContaining("results") });
});

test("fetchがハングしてもタイムアウトで解決する", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      // 応答が返らないまま signal の中断だけを待つ、ハングしたサーバーを模す。
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }),
  );

  const outcome = await syncEvent(EVENT, CONFIG);

  expect(outcome.ok).toBe(false);
}, 20_000);
