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
  await Promise.resolve();
  expect(fetchMock).toHaveBeenCalledTimes(1);

  resolveFetch?.(
    new Response(
      JSON.stringify({ access_token: "access-shared", token_type: "Bearer", expires_in: 900 }),
    ),
  );
  await expect(Promise.all([first, second])).resolves.toEqual(["access-shared", "access-shared"]);
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
