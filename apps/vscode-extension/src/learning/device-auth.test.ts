import { afterEach, expect, test, vi } from "vitest";

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn().mockResolvedValue(true) }));
vi.mock("vscode", () => ({
  env: { openExternal },
  Uri: { parse: vi.fn((value: string) => value) },
  window: { showInformationMessage: vi.fn() },
}));

import { DeviceAuth } from "./device-auth";

function secrets(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: vi.fn(async (key: string) => values.get(key)),
    store: vi.fn(async (key: string, value: string) => void values.set(key, value)),
    delete: vi.fn(async (key: string) => void values.delete(key)),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

test("Device Flow は offline_access を要求し、Refresh Token を保存する", async () => {
  const storage = secrets();
  const sleeps: number[] = [];
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            device_code: "device-1",
            user_code: "ABCD-EFGH",
            verification_uri: "https://example.com/activate",
            expires_in: 600,
            interval: 1,
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "access-1",
            token_type: "Bearer",
            expires_in: 900,
            refresh_token: "refresh-1",
          }),
        ),
      ),
  );

  await new DeviceAuth(storage, {
    sleep: async (milliseconds) => void sleeps.push(milliseconds),
  }).login();

  const fetchMock = vi.mocked(fetch);
  const deviceBody = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
  expect(deviceBody.get("scope")).toContain("offline_access");
  expect(deviceBody.get("audience")).toBe("https://api.gakushu-sochi.dev");
  expect(sleeps).toEqual([1_000, 1_000]);
  expect(storage.store).toHaveBeenCalledWith("gakushuSochi.auth.refreshToken", "refresh-1");
});

test("Refresh Token が無ければ再ログインを要求する", async () => {
  const auth = new DeviceAuth(secrets());

  await expect(auth.getAccessToken()).rejects.toThrow("再ログインが必要です");
});

test("Refresh Token のローテーション応答を保存する", async () => {
  const storage = secrets({ "gakushuSochi.auth.refreshToken": "refresh-old" });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "access-2",
          token_type: "Bearer",
          expires_in: 900,
          refresh_token: "refresh-new",
        }),
      ),
    ),
  );

  await expect(new DeviceAuth(storage).getAccessToken()).resolves.toBe("access-2");
  expect(storage.store).toHaveBeenCalledWith("gakushuSochi.auth.refreshToken", "refresh-new");
});

test("同時に要求されたトークン更新は1回だけ実行する", async () => {
  const storage = secrets({ "gakushuSochi.auth.refreshToken": "refresh-old" });
  let resolveFetch: ((response: Response) => void) | undefined;
  const fetchPromise = new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  });
  const fetchMock = vi.fn().mockReturnValue(fetchPromise);
  vi.stubGlobal("fetch", fetchMock);

  const auth = new DeviceAuth(storage);
  const first = auth.getAccessToken();
  const second = auth.getAccessToken();
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

  resolveFetch?.(
    new Response(
      JSON.stringify({ access_token: "access-shared", token_type: "Bearer", expires_in: 900 }),
    ),
  );
  await expect(Promise.all([first, second])).resolves.toEqual(["access-shared", "access-shared"]);
});

test("新しいログインは進行中の古いトークン更新に上書きされない", async () => {
  const storage = secrets({ "gakushuSochi.auth.refreshToken": "refresh-old" });
  let resolveRefresh: ((response: Response) => void) | undefined;
  const refreshResponse = new Promise<Response>((resolve) => {
    resolveRefresh = resolve;
  });
  const fetchMock = vi
    .fn()
    .mockReturnValueOnce(refreshResponse)
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          device_code: "device-1",
          user_code: "ABCD-EFGH",
          verification_uri: "https://example.com/activate",
          expires_in: 600,
          interval: 1,
        }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "access-login",
          token_type: "Bearer",
          expires_in: 900,
          refresh_token: "refresh-login",
        }),
      ),
    );
  vi.stubGlobal("fetch", fetchMock);

  const auth = new DeviceAuth(storage, { sleep: async () => undefined });
  const refreshing = auth.getAccessToken();
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const loggingIn = auth.login();
  await loggingIn;

  resolveRefresh?.(
    new Response(
      JSON.stringify({
        access_token: "access-old-refresh",
        token_type: "Bearer",
        expires_in: 900,
        refresh_token: "refresh-old-refresh",
      }),
    ),
  );

  await expect(refreshing).rejects.toThrow("再ログインが必要です");
  await expect(storage.get("gakushuSochi.auth.refreshToken")).resolves.toBe("refresh-login");
});

test("ログアウト中に完了したトークン更新は認証状態を書き戻さない", async () => {
  const storage = secrets({ "gakushuSochi.auth.refreshToken": "refresh-old" });
  let resolveRefresh: ((response: Response) => void) | undefined;
  const refreshPromise = new Promise<Response>((resolve) => {
    resolveRefresh = resolve;
  });
  const fetchMock = vi
    .fn()
    .mockReturnValueOnce(refreshPromise)
    .mockResolvedValueOnce(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  const auth = new DeviceAuth(storage);
  const refreshing = auth.getAccessToken();
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

  await auth.logout();
  resolveRefresh?.(
    new Response(
      JSON.stringify({
        access_token: "access-after-logout",
        token_type: "Bearer",
        expires_in: 900,
        refresh_token: "refresh-after-logout",
      }),
    ),
  );

  await expect(refreshing).rejects.toThrow("再ログインが必要です");
  await expect(storage.get("gakushuSochi.auth.refreshToken")).resolves.toBeUndefined();
  await expect(auth.getAccessToken()).rejects.toThrow("再ログインが必要です");
});

test("Refresh Token の保存中にログアウトしたら削除を保存完了後に行う", async () => {
  let stored: string | undefined = "refresh-old";
  let resolveStore: (() => void) | undefined;
  const storeStarted = new Promise<void>((resolve) => {
    resolveStore = resolve;
  });
  let resolveStoreCompletion: (() => void) | undefined;
  const storeCompletion = new Promise<void>((resolve) => {
    resolveStoreCompletion = resolve;
  });
  const storage = {
    get: vi.fn(async () => stored),
    store: vi.fn(async (_key: string, value: string) => {
      resolveStore?.();
      await storeCompletion;
      stored = value;
    }),
    delete: vi.fn(async () => {
      stored = undefined;
    }),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "access-2",
            token_type: "Bearer",
            expires_in: 900,
            refresh_token: "refresh-new",
          }),
        ),
    ),
  );

  const auth = new DeviceAuth(storage);
  const refreshing = auth.getAccessToken();
  await storeStarted;
  const clearing = auth.clear();
  resolveStoreCompletion?.();

  await expect(refreshing).rejects.toThrow("再ログインが必要です");
  await clearing;
  expect(stored).toBeUndefined();
});

test("ログアウトによる削除中に始まった更新は削除完了後に保存先を読む", async () => {
  let stored: string | undefined = "refresh-old";
  let resolveDelete: (() => void) | undefined;
  const deleteCompletion = new Promise<void>((resolve) => {
    resolveDelete = resolve;
  });
  const storage = {
    get: vi.fn(async () => stored),
    store: vi.fn(async (_key: string, value: string) => {
      stored = value;
    }),
    delete: vi.fn(async () => {
      await deleteCompletion;
      stored = undefined;
    }),
  };
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ access_token: "access-2", token_type: "Bearer", expires_in: 900 }),
      ),
  );
  vi.stubGlobal("fetch", fetchMock);

  const auth = new DeviceAuth(storage);
  const clearing = auth.clear();
  const refreshing = auth.getAccessToken();
  await Promise.resolve();

  expect(storage.get).not.toHaveBeenCalled();
  resolveDelete?.();
  await clearing;
  await expect(refreshing).rejects.toThrow("再ログインが必要です");
  expect(fetchMock).not.toHaveBeenCalled();
});

test("ログアウト中に完了したログインは認証状態を書き戻さない", async () => {
  const storage = secrets();
  let resolveToken: ((response: Response) => void) | undefined;
  const tokenResponse = new Promise<Response>((resolve) => {
    resolveToken = resolve;
  });
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          device_code: "device-1",
          user_code: "ABCD-EFGH",
          verification_uri: "https://example.com/activate",
          expires_in: 600,
          interval: 1,
        }),
      ),
    )
    .mockReturnValueOnce(tokenResponse);
  vi.stubGlobal("fetch", fetchMock);

  const auth = new DeviceAuth(storage, { sleep: async () => undefined });
  const loggingIn = auth.login();
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

  await auth.logout();
  resolveToken?.(
    new Response(
      JSON.stringify({
        access_token: "access-after-logout",
        token_type: "Bearer",
        expires_in: 900,
        refresh_token: "refresh-after-logout",
      }),
    ),
  );

  await expect(loggingIn).rejects.toThrow("再ログインが必要です");
  await expect(storage.get("gakushuSochi.auth.refreshToken")).resolves.toBeUndefined();
});

test("intervalが正の有限値でなければDevice Flowを開始しない", async () => {
  const storage = secrets();
  const sleep = vi.fn(async () => undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          device_code: "device-1",
          user_code: "ABCD-EFGH",
          verification_uri: "https://example.com/activate",
          expires_in: 600,
          interval: 0,
        }),
      ),
    ),
  );

  await expect(new DeviceAuth(storage, { sleep }).login()).rejects.toThrow("interval が不正です");
  expect(sleep).not.toHaveBeenCalled();
});

test("ログアウトは先にローカルの Refresh Token を破棄してから撤回する", async () => {
  // 順序の記録。逆だと、撤回の通信で失敗したときに SecretStorage へ
  // トークンが残り、ログアウトしたつもりの端末がログイン済みのままになる。
  const calls: string[] = [];
  const storage = secrets({ "gakushuSochi.auth.refreshToken": "refresh-1" });
  storage.delete.mockImplementation(async () => void calls.push("clear"));
  const fetchMock = vi.fn(async () => {
    calls.push("revoke");
    return new Response(null, { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);

  await new DeviceAuth(storage).logout();

  expect(calls).toEqual(["clear", "revoke"]);

  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://gakushu-sochi.jp.auth0.com/oauth/revoke");
  // public client なので client_secret は送らない（配布物に隠せない）。
  expect(JSON.parse(init.body as string)).toEqual({
    client_id: "QkzWUVBYTbVYoye8SbHxaKbam6sSj014",
    token: "refresh-1",
  });
  expect(init.redirect).toBe("error");
});

test("撤回に失敗してもローカルの Refresh Token は消えたままで、例外にしない", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const storage = secrets({ "gakushuSochi.auth.refreshToken": "refresh-1" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ error: "invalid_request" }), { status: 400 })),
  );

  // 利用者から見たログアウトは、ローカルの破棄が終わった時点で成立している。
  await expect(new DeviceAuth(storage).logout()).resolves.toBeUndefined();

  expect(await storage.get("gakushuSochi.auth.refreshToken")).toBeUndefined();
  // 握りつぶさず記録する（.agents/rules/rules.md RULE-004）。
  expect(consoleError).toHaveBeenCalled();

  consoleError.mockRestore();
});

test("保存された Refresh Token が無ければ撤回を空撃ちしない", async () => {
  const storage = secrets();
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  await new DeviceAuth(storage).logout();

  expect(fetchMock).not.toHaveBeenCalled();
});

test("Refresh Token の読み取りに失敗してもローカル削除を試みる", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const storage = secrets({ "gakushuSochi.auth.refreshToken": "refresh-1" });
  storage.get.mockRejectedValueOnce(new Error("cannot read secret"));
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  await expect(new DeviceAuth(storage).logout()).resolves.toBeUndefined();

  expect(storage.delete).toHaveBeenCalledWith("gakushuSochi.auth.refreshToken");
  expect(fetchMock).not.toHaveBeenCalled();
  expect(consoleError).toHaveBeenCalledWith(
    "failed to read the refresh token before local logout",
    expect.objectContaining({ message: "cannot read secret" }),
  );
  consoleError.mockRestore();
});
