import { afterEach, expect, test, vi } from "vitest";
import type { LearningEvent } from "@gakushu-sochi/domain";
import { deleteServerLearningData, fetchUserConcepts, syncEvent } from "./sync";

const EVENT: LearningEvent = {
  id: "event-1",
  occurredAt: "2026-09-06T00:00:00.000Z",
  type: "answer_viewed",
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

  expect(outcome).toEqual({
    ok: true,
    status: "accepted",
    reason: undefined,
    historyResetAtMs: null,
    droppedByReset: false,
  });
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

test("同意の確認が例外を投げても、例外にせず失敗を返す", async () => {
  // 同期の失敗が質問フローを止めてはならない（このファイル冒頭の約束）。
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  const outcome = await syncEvent(EVENT, {
    ...CONFIG,
    canSend: () => {
      throw new Error("consent store is broken");
    },
  });

  expect(outcome).toEqual({
    ok: false,
    reason: expect.stringContaining("consent store is broken"),
  });
  expect(fetchMock).not.toHaveBeenCalled();
});

test("イベントを JSON にできなくても、例外にせず失敗を返す", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const unserializable = { ...EVENT, extra: 1n } as unknown as LearningEvent;

  const outcome = await syncEvent(unserializable, CONFIG);

  expect(outcome).toEqual({ ok: false, reason: expect.stringContaining("BigInt") });
  expect(fetchMock).not.toHaveBeenCalled();
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

  expect(outcome).toEqual({
    ok: true,
    status: "duplicate",
    reason: undefined,
    historyResetAtMs: null,
    droppedByReset: false,
  });
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

  expect(outcome).toEqual({
    ok: true,
    status: "accepted",
    reason: undefined,
    historyResetAtMs: null,
    droppedByReset: false,
  });
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

test("ヘッダーのあと本文が止まれば、タイムアウトで本文の読み込みも中断する", async () => {
  // 本文の読み込みも期限の内側（RULE-001）。中断しないと、失敗を返したあとも接続が残る。
  vi.useFakeTimers();
  const signals: AbortSignal[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const signal = init.signal!;
      signals.push(signal);
      // 本物の fetch と同じく、signal の中断で本文のストリームを失敗させる。
      const body = new ReadableStream({
        start(controller) {
          signal.addEventListener("abort", () => controller.error(signal.reason));
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    }),
  );

  const pending = syncEvent(EVENT, CONFIG);
  await vi.advanceTimersByTimeAsync(10_000);
  const outcome = await pending;
  vi.useRealTimers();

  expect(outcome.ok).toBe(false);
  expect(signals[0]?.aborted).toBe(true);
});

// --- #124: サーバー側の削除への追従 -------------------------------------------

test("応答の削除時刻を呼び出し側へ返す", async () => {
  // 他端末が DELETE /v1/learning-events を呼んだあと、この端末は同期応答の
  // historyResetAtMs で削除を知る。
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [{ status: "accepted" }],
          historyResetAtMs: 1_700_000_000_000,
        }),
        { status: 200 },
      ),
    ),
  );

  const outcome = await syncEvent(EVENT, CONFIG);

  expect(outcome).toEqual({
    ok: true,
    status: "accepted",
    reason: undefined,
    historyResetAtMs: 1_700_000_000_000,
    droppedByReset: false,
  });
});

test("削除境界に吞まれた受理を呼び出し側へ伝える", async () => {
  // status は accepted のまま。サーバーへは保存されなかったイベントであり、
  // 追従後にローカルへ記録し直すかの区別だけに使う（Issue #124）。
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [{ status: "accepted", droppedByReset: true }],
          historyResetAtMs: 1_000,
        }),
        { status: 200 },
      ),
    ),
  );

  const outcome = await syncEvent(EVENT, CONFIG);

  expect(outcome).toEqual({
    ok: true,
    status: "accepted",
    reason: undefined,
    historyResetAtMs: 1_000,
    droppedByReset: true,
  });
});

test("削除時刻が数値でもnullでも無ければ失敗を返す", async () => {
  // 契約と違う形を黙って無視しない（RULE-004）。
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ results: [{ status: "accepted" }], historyResetAtMs: "2026-09-23" }),
          { status: 200 },
        ),
      ),
  );

  const outcome = await syncEvent(EVENT, CONFIG);

  expect(outcome).toEqual({
    ok: false,
    reason: expect.stringContaining("historyResetAtMs"),
  });
});

test("削除時刻のフィールドが無い古いサーバーからの応答も受理する", async () => {
  // 後方互換。フィールドが無いことを「削除済み」の根拠にはしない。
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ results: [{ status: "accepted" }] }), { status: 200 }),
      ),
  );

  const outcome = await syncEvent(EVENT, CONFIG);

  expect(outcome).toEqual({
    ok: true,
    status: "accepted",
    historyResetAtMs: null,
    droppedByReset: false,
  });
});

// --- #124: DELETE /v1/learning-events -----------------------------------------

test("サーバー削除の成功では件数と削除時刻を返す", async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ deletedCount: 3, resetAtMs: 1_700_000_000_000 }), {
      status: 200,
    }),
  );
  vi.stubGlobal("fetch", fetchMock);

  const outcome = await deleteServerLearningData(CONFIG);

  expect(outcome).toEqual({ ok: true, deletedCount: 3, resetAtMs: 1_700_000_000_000 });
  expect(fetchMock).toHaveBeenCalledWith(
    "https://api.example.com/v1/learning-events",
    expect.objectContaining({
      method: "DELETE",
      headers: expect.objectContaining({ authorization: "Bearer test-token" }),
      redirect: "error",
    }),
  );
});

test("サーバー削除で認証切れの401なら再ログインを案内する", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));

  const outcome = await deleteServerLearningData(CONFIG);

  expect(outcome).toEqual({ ok: false, reason: "再ログインが必要です" });
});

test("サーバー削除がHTTPエラーならローカルは消さずに失敗を返す", async () => {
  // 呼び出し側は ok: false のときローカルを消さない。サーバー側が残ったまま
  // 手元だけ消える「消えたように見える」状態を作らないため。
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));

  const outcome = await deleteServerLearningData(CONFIG);

  expect(outcome).toEqual({ ok: false, reason: "HTTP 500" });
});

test("サーバー削除で2xxでも本文が契約と違えば失敗を返す", async () => {
  // 実際には消せていないかもしれないのに「消せた」としてローカルを消さない。
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ deletedCount: 3 }), { status: 200 })),
  );

  const outcome = await deleteServerLearningData(CONFIG);

  expect(outcome).toEqual({ ok: false, reason: expect.stringContaining("形式が不正") });
});

test("サーバー削除でネットワークエラーなら例外を投げず失敗を返す", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

  const outcome = await deleteServerLearningData(CONFIG);

  expect(outcome.ok).toBe(false);
  expect((outcome as { reason: string }).reason).toContain("fetch failed");
});

test("サーバー削除もhttpのリモートURLへはトークンを送らずに拒否する", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  const outcome = await deleteServerLearningData({
    ...CONFIG,
    apiBaseUrl: "http://api.example.com",
  });

  expect(outcome.ok).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("自分のマップのノードは、トークン付き・リダイレクト拒否の GET で読む（#242）", async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    Response.json({
      concepts: [
        {
          id: "mrust0001.owner001",
          label: "所有権",
          summary: "s",
          mapId: "mrust0001",
          mapTitle: "Rust 入門",
          prerequisites: [],
          objectives: [],
        },
      ],
      fixedObjectives: [],
    }),
  );
  vi.stubGlobal("fetch", fetchMock);

  const outcome = await fetchUserConcepts(CONFIG);

  expect(outcome).toMatchObject({
    ok: true,
    value: { concepts: [{ id: "mrust0001.owner001", label: "所有権（Rust 入門）" }] },
  });
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("https://api.example.com/v1/learning-maps:concepts");
  expect(init.method).toBe("GET");
  expect(init.redirect).toBe("error");
  expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-token");
});

test("自分のマップのノードの応答が契約と違えば、失敗として返す", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ concepts: [{ id: 1 }] })));

  await expect(fetchUserConcepts(CONFIG)).resolves.toEqual({
    ok: false,
    reason: "サーバー応答の形式が不正です（concepts の形が契約と違います）",
  });
});
