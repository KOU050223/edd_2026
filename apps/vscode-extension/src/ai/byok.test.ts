import { afterEach, expect, test, vi } from "vitest";
import type { AIRequest } from "@gakushu-sochi/domain";
import { BYOKProvider, byokSecretKey, isByokVendor, isSafeByokBaseUrl } from "./byok";
import { META_MARKER } from "./prompt";

const REQUEST: AIRequest = {
  context: {
    code: "const answer = 42;",
    source: "editor",
    contextLevel: 2,
    surroundingCode: "const answer = 42;",
    languageId: "typescript",
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/** fetch の呼び出しを記録し、固定の応答を返すスタブを仕込む。 */
function stubFetch(body: unknown, status = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    }),
  );
  return calls;
}

test("Anthropic 経路で質問すると、API キー付きの Messages API 呼び出しになり、応答本文が回答になる", async () => {
  const calls = stubFetch({ content: [{ type: "text", text: "回答です" }] });

  const response = await new BYOKProvider({
    vendor: "anthropic",
    apiKey: "sk-ant-test",
  }).ask(REQUEST);

  expect(calls).toHaveLength(1);
  const { url, init } = calls[0]!;
  expect(url).toBe("https://api.anthropic.com/v1/messages");
  expect(init?.method).toBe("POST");
  const headers = init?.headers as Record<string, string>;
  expect(headers["x-api-key"]).toBe("sk-ant-test");
  expect(headers["anthropic-version"]).toBe("2023-06-01");
  const body = JSON.parse(init?.body as string);
  expect(body.model).toBe("claude-haiku-4-5-20251001");
  expect(body.messages.at(-1).role).toBe("user");
  expect(body.messages.at(-1).content).toContain("const answer = 42;");

  expect(response.ok).toBe(true);
  if (response.ok) {
    expect(response.answer.text).toBe("回答です");
    expect(response.answer.model).toBe("claude-haiku-4-5-20251001");
  }
});

test("OpenAI 経路では Bearer 認証の Chat Completions 呼び出しになる", async () => {
  const calls = stubFetch({ choices: [{ message: { content: "OpenAI の回答" } }] });

  const response = await new BYOKProvider({
    vendor: "openai",
    apiKey: "sk-test",
  }).ask(REQUEST);

  expect(calls).toHaveLength(1);
  const { url, init } = calls[0]!;
  expect(url).toBe("https://api.openai.com/v1/chat/completions");
  expect((init?.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
  const body = JSON.parse(init?.body as string);
  expect(body.model).toBe("gpt-4o-mini");

  expect(response.ok).toBe(true);
  if (response.ok) {
    expect(response.answer.text).toBe("OpenAI の回答");
  }
});

test("応答末尾のメタ情報は表示本文から切り離され、既知の Concept ID だけが残る", async () => {
  stubFetch({
    content: [
      {
        type: "text",
        text: `本文です\n${META_MARKER}\n{"conceptIds": ["ts.variable_declaration", "ts.unknown_concept"], "resolution": "resolved"}`,
      },
    ],
  });

  const response = await new BYOKProvider({ vendor: "anthropic", apiKey: "k" }).ask(REQUEST);

  expect(response.ok).toBe(true);
  if (response.ok) {
    expect(response.answer.text).toBe("本文です");
    expect(response.answer.conceptIds).toEqual(["ts.variable_declaration"]);
    expect(response.answer.resolution).toBe("resolved");
  }
});

test("API キーが未設定なら、送信せず設定コマンドへの案内を添えて失敗を返す", async () => {
  const calls = stubFetch({});

  const response = await new BYOKProvider({ vendor: "anthropic" }).ask(REQUEST);

  // 黙って既定キーや別経路へ落とさない。失敗と次の一手を返す（RULE-004）。
  expect(calls).toHaveLength(0);
  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.reason).toBe("model-unavailable");
    expect(response.error.detail).toContain("API キーが未設定");
  }
});

test("未対応の vendor が設定されていても、送信せず失敗を返す", async () => {
  const calls = stubFetch({});

  const response = await new BYOKProvider({ vendor: "gemini", apiKey: "k" }).ask(REQUEST);

  expect(calls).toHaveLength(0);
  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.reason).toBe("model-unavailable");
    expect(response.error.detail).toContain("gemini");
  }
});

test("平文 HTTP の外部宛てには API キーを送らない", async () => {
  const calls = stubFetch({});

  const response = await new BYOKProvider({
    vendor: "openai",
    apiKey: "sk-test",
    baseUrl: "http://evil.example.com",
  }).ask(REQUEST);

  expect(calls).toHaveLength(0);
  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.reason).toBe("model-unavailable");
  }
});

test("ループバックの HTTP エンドポイントはローカルモデル向けに許可する", async () => {
  const calls = stubFetch({ choices: [{ message: { content: "ローカルの回答" } }] });

  const response = await new BYOKProvider({
    vendor: "openai",
    apiKey: "ollama",
    baseUrl: "http://localhost:11434",
  }).ask(REQUEST);

  expect(calls[0]?.url).toBe("http://localhost:11434/v1/chat/completions");
  expect(response.ok).toBe(true);
});

test("ループバックのエンドポイントは API キーなしで呼べる", async () => {
  // Ollama 等のローカルモデルは認証を持たない。ダミーのキーを要求しない。
  const calls = stubFetch({ choices: [{ message: { content: "ローカルの回答" } }] });

  const response = await new BYOKProvider({
    vendor: "openai",
    baseUrl: "http://localhost:11434",
  }).ask(REQUEST);

  expect(calls).toHaveLength(1);
  const headers = calls[0]?.init?.headers as Record<string, string>;
  expect(headers.authorization).toBeUndefined();
  expect(response.ok).toBe(true);
});

test("baseUrl が /v1 で終わっていても、パスを二重にしない", async () => {
  // OpenAI 互換の案内は `.../v1` 込みのことが多い（Ollama、OpenRouter 等）。
  const calls = stubFetch({ choices: [{ message: { content: "ok" } }] });

  await new BYOKProvider({
    vendor: "openai",
    apiKey: "k",
    baseUrl: "http://localhost:11434/v1/",
  }).ask(REQUEST);

  expect(calls[0]?.url).toBe("http://localhost:11434/v1/chat/completions");
});

test("404 の案内は model だけでなく baseUrl の確認も促す", async () => {
  // OpenAI 互換エンドポイントでは URL 側の誤りでも 404 になりうる。
  stubFetch({ error: { message: "not found" } }, 404);

  const response = await new BYOKProvider({ vendor: "openai", apiKey: "k" }).ask(REQUEST);

  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.detail).toContain("byok.model");
    expect(response.error.detail).toContain("byok.baseUrl");
  }
});

test("401 / 403 は API キーの問題として auth-failed を返す", async () => {
  for (const status of [401, 403]) {
    const calls = stubFetch({ error: { message: "invalid api key" } }, status);

    const response = await new BYOKProvider({ vendor: "anthropic", apiKey: "k" }).ask(REQUEST);

    expect(calls).toHaveLength(1);
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.reason).toBe("auth-failed");
      expect(response.error.detail).toContain("invalid api key");
    }
    vi.unstubAllGlobals();
  }
});

test.each([
  [429, "rate-limited"],
  [404, "model-unavailable"],
  [500, "unknown"],
] as const)("HTTP %i は %s として呼び出し側が判別できる", async (status, reason) => {
  stubFetch({ error: { message: "server error" } }, status);

  const response = await new BYOKProvider({ vendor: "openai", apiKey: "k" }).ask(REQUEST);

  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.reason).toBe(reason);
  }
});

test("コンテキスト長超過のエラーは context-too-long として返す", async () => {
  stubFetch({ error: { code: "context_length_exceeded", message: "too long" } }, 400);

  const response = await new BYOKProvider({ vendor: "openai", apiKey: "k" }).ask(REQUEST);

  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.reason).toBe("context-too-long");
  }
});

test("OpenAI 経路の要求には出力トークンの上限を付ける", async () => {
  // 上限なしだと長い応答を全量生成し、課金と待ち時間が伸びる。
  const calls = stubFetch({ choices: [{ message: { content: "ok" } }] });

  await new BYOKProvider({ vendor: "openai", apiKey: "k" }).ask(REQUEST);

  const body = JSON.parse(calls[0]?.init?.body as string);
  expect(body.max_tokens).toBe(4096);
});

test("空白だけの応答本文は成功として扱わない", async () => {
  // "   " は真だが parseAnswer で空になり、回答なしのまま
  // answer_viewed が記録されてしまう。構造欠落と同じく失敗にする。
  stubFetch({ choices: [{ message: { content: "   " } }] });

  const response = await new BYOKProvider({ vendor: "openai", apiKey: "k" }).ask(REQUEST);

  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.reason).toBe("unknown");
  }
});

test("429 insufficient_quota は再試行ではなく請求設定の確認を案内する", async () => {
  // クレジット・請求枠の枯渇は待っても解消しないため、レート制限と分ける。
  stubFetch({ error: { code: "insufficient_quota", message: "quota exceeded" } }, 429);

  const response = await new BYOKProvider({ vendor: "openai", apiKey: "k" }).ask(REQUEST);

  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.reason).toBe("rate-limited");
    expect(response.error.detail).toContain("請求");
    expect(response.error.detail).not.toContain("しばらくしてから");
  }
});

test("2xx でも本文の解析に失敗したら失敗として扱う", async () => {
  stubFetch("not-json", 200);

  const response = await new BYOKProvider({ vendor: "anthropic", apiKey: "k" }).ask(REQUEST);

  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.reason).toBe("unknown");
  }
});

test("ネットワークエラーは例外ではなく失敗応答を返す", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("socket hang up");
    }),
  );

  const response = await new BYOKProvider({ vendor: "anthropic", apiKey: "k" }).ask(REQUEST);

  expect(response).toEqual({
    ok: false,
    error: { reason: "unknown", detail: "Error: socket hang up" },
  });
});

test("送信直前に同意が取り消されていたら、API キーを送らない", async () => {
  const calls = stubFetch({});

  const response = await new BYOKProvider(
    { vendor: "anthropic", apiKey: "k" },
    undefined,
    () => false,
  ).ask(REQUEST);

  expect(calls).toHaveLength(0);
  expect(response).toEqual({
    ok: false,
    error: { reason: "consent-denied", detail: "送信の同意が取り消されました。" },
  });
});

test("API キーを送る要求はリダイレクトを自動追跡せず、応答なしに待ち続けない", async () => {
  const calls = stubFetch({ content: [{ type: "text", text: "ok" }] });

  await new BYOKProvider({ vendor: "anthropic", apiKey: "k" }).ask(REQUEST);

  // RULE-002: 転送先へキーごと渡るのを防ぐ。RULE-001: 単発 fetch にタイムアウト。
  expect(calls[0]?.init?.redirect).toBe("error");
  expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
});

test("会話履歴は直近10件だけを送り、最後にプロンプトを置く", async () => {
  const calls = stubFetch({ content: [{ type: "text", text: "ok" }] });
  const history = Array.from({ length: 15 }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    text: `turn-${i}`,
  }));

  await new BYOKProvider({ vendor: "anthropic", apiKey: "k" }).ask({ ...REQUEST, history });

  const body = JSON.parse(calls[0]?.init?.body as string);
  const texts = body.messages.map((m: { content: string }) => m.content);
  // 15件の履歴のうち末尾10件（turn-5〜14）を切るが、先頭の turn-5 は assistant。
  // Anthropic は先頭が user でなければ 400 なので、user 開始まで落とす。
  // 末尾の turn-14 は user で、今回のプロンプトと1件に畳み込まれる。
  expect(body.messages).toHaveLength(9);
  expect(body.messages[0].role).toBe("user");
  expect(texts[0]).toBe("turn-6");
  expect(texts.at(-1)).toContain("turn-14");
  expect(texts.at(-1)).toContain("const answer = 42;");
});

test("履歴の先頭が assistant なら、user 開始まで落とす", async () => {
  // Anthropic の「first message must use the "user" role」対策。
  // 対になる質問を持たない先頭の応答は、送っても文脈にならない。
  const calls = stubFetch({ content: [{ type: "text", text: "ok" }] });
  const history = [
    { role: "assistant" as const, text: "前の応答" },
    { role: "user" as const, text: "次の質問" },
    { role: "assistant" as const, text: "次の回答" },
  ];

  await new BYOKProvider({ vendor: "anthropic", apiKey: "k" }).ask({ ...REQUEST, history });

  const messages = JSON.parse(calls[0]?.init?.body as string).messages;
  expect(messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "user"]);
  expect(messages[0].content).toBe("次の質問");
});

test("履歴末尾が user で終わる場合、今回のプロンプトと1件に畳み込む", async () => {
  // Anthropic は user/assistant の交互を強制する。前回ターンが応答なく
  // 終わった履歴だと、そのまま送ると連続 user になって 400 になる。
  const calls = stubFetch({ content: [{ type: "text", text: "ok" }] });
  const history = [
    { role: "user" as const, text: "最初の質問" },
    { role: "assistant" as const, text: "最初の回答" },
    { role: "user" as const, text: "応答の無い質問" },
  ];

  await new BYOKProvider({ vendor: "anthropic", apiKey: "k" }).ask({ ...REQUEST, history });

  const messages = JSON.parse(calls[0]?.init?.body as string).messages;
  expect(messages).toHaveLength(3);
  expect(messages[2].role).toBe("user");
  expect(messages[2].content).toContain("応答の無い質問");
  expect(messages[2].content).toContain("const answer = 42;");
});

test("空のテキストを持つ履歴ターンは送らない", async () => {
  // Anthropic は空の content を 400 で弾く。[context:...] だけの入力などで
  // 履歴へ空のターンが残りうるため、ここで除く。
  const calls = stubFetch({ content: [{ type: "text", text: "ok" }] });
  const history = [
    { role: "user" as const, text: "質問" },
    { role: "assistant" as const, text: "" },
    { role: "user" as const, text: "  " },
  ];

  await new BYOKProvider({ vendor: "anthropic", apiKey: "k" }).ask({ ...REQUEST, history });

  const messages = JSON.parse(calls[0]?.init?.body as string).messages;
  // 空ターンが除かれると「質問」と今回のプロンプトが連続 user になり、畳み込まれる。
  expect(messages).toHaveLength(1);
  expect(messages[0].content).toContain("質問");
  expect(messages[0].content).toContain("const answer = 42;");
});

test("isByokVendor は対応する提供元名だけを通す", () => {
  expect(isByokVendor("anthropic")).toBe(true);
  expect(isByokVendor("openai")).toBe(true);
  expect(isByokVendor("gemini")).toBe(false);
  expect(isByokVendor("")).toBe(false);
  expect(isByokVendor(undefined)).toBe(false);
});

test("isSafeByokBaseUrl は https とループバックの http だけを許す", () => {
  expect(isSafeByokBaseUrl("https://api.openai.com")).toBe(true);
  expect(isSafeByokBaseUrl("http://localhost:11434")).toBe(true);
  expect(isSafeByokBaseUrl("http://127.0.0.1:8080")).toBe(true);
  expect(isSafeByokBaseUrl("http://[::1]:8080")).toBe(true);

  expect(isSafeByokBaseUrl("http://example.com")).toBe(false);
  expect(isSafeByokBaseUrl("ftp://localhost")).toBe(false);
  expect(isSafeByokBaseUrl("not a url")).toBe(false);
});

test("byokSecretKey は提供元ごとに別のキーを返す", () => {
  expect(byokSecretKey("anthropic")).not.toBe(byokSecretKey("openai"));
  expect(byokSecretKey("anthropic")).toContain("anthropic");
});
