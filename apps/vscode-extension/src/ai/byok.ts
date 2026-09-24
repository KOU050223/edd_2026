/**
 * 利用者自身の API キーで AI を呼ぶ AIProvider（AI/04 #55）。
 *
 * `vscode.lm` 経由（VSCodeLMProvider）と異なり、拡張が直接 HTTPS で
 * AI 提供元の API を叩く経路。対象は Anthropic Messages API と
 * OpenAI Chat Completions API（互換エンドポイントを含む）。
 *
 * API キーは利用者の端末の SecretStorage にだけ保存され、
 * 運営側のサーバーへは送らない（docs/architecture.md の BYOK の方針）。
 * キーの読み出し自体は呼び出し側（extension.ts）が行い、ここには
 * 解決済みの値だけが渡される。そのためこのファイルは vscode に依存しない
 * （src/ai/ の no-restricted-imports でも強制されている）。
 */

import type { AIProvider } from "./provider";
import { buildPrompt } from "./prompt";
import { MAX_HISTORY_TURNS, parseAnswer } from "./answer";
import type { AIError, AIRequest, AIResponse } from "./types";

/** BYOK で対応する AI 提供元。 */
export const BYOK_VENDORS = ["anthropic", "openai"] as const;
export type ByokVendor = (typeof BYOK_VENDORS)[number];

/** 設定値が対応する提供元名か。package.json の enum を通さず書かれた値もここで弾く。 */
export function isByokVendor(value: unknown): value is ByokVendor {
  return BYOK_VENDORS.includes(value as ByokVendor);
}

/** SecretStorage 上のキー。提供元ごとに別のキーを持つ。 */
export function byokSecretKey(vendor: ByokVendor): string {
  return `gakushuSochi.byok.apiKey.${vendor}`;
}

/** vendor ごとの既定モデル。`gakushuSochi.byok.model` が空のときに使う。 */
const DEFAULT_MODELS: Record<ByokVendor, string> = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-4o-mini",
};

/** vendor ごとの既定の送信先。`gakushuSochi.byok.baseUrl` が空のときに使う。 */
const DEFAULT_BASE_URLS: Record<ByokVendor, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
};

/**
 * 応答が返らない場合に待ち続けない上限。
 *
 * 生成は入力に比べて時間がかかるため、learning/sync.ts の 10 秒ではなく
 * 長めに取る。それでも上限は必要で、無いと応答を待つ UI が固まる（RULE-001）。
 */
const TIMEOUT_MS = 120_000;

/** 1回の応答で返してもらうトークンの上限。Anthropic は必須項目。 */
const MAX_OUTPUT_TOKENS = 4096;

/**
 * 送信先として安全な URL かどうか（RULE-003）。
 *
 * ここへ API キーを載せて送るため、平文の http: を許すとキーが盗聴されうる。
 * ローカル開発や Ollama などのローカルモデル向けに loopback の http: だけ認める。
 * learning/sync.ts の isSafeApiBaseUrl と同じ判断基準。
 */
export function isSafeByokBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** BYOK の設定。値は VS Code の設定・SecretStorage を呼び出し側が解決して渡す。 */
export interface ByokProviderConfig {
  /**
   * `gakushuSochi.byok.vendor` の生の値。
   * 設定には enum ではない値を書き込めるため、ここでは文字列として受け、
   * 未対応の値は ask() が失敗として返す（黙って既定へ落とさない。RULE-004）。
   */
  vendor: string;
  /** 利用者の API キー。未設定なら undefined。 */
  apiKey?: string;
  /** `gakushuSochi.byok.model`。空なら vendor の既定。 */
  model?: string;
  /** `gakushuSochi.byok.baseUrl`。空なら vendor の既定。OpenAI 互換エンドポイント向け。 */
  baseUrl?: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** AIRequest を、各社 API に共通する単純な messages 配列へ変換する。 */
function toChatMessages(request: AIRequest): ChatMessage[] {
  // 直近 MAX_HISTORY_TURNS 件だけを使う（vscodeLm.ts と同じ上限）。
  const history = (request.history ?? []).slice(-MAX_HISTORY_TURNS);

  return [
    ...history.map((turn) => ({ role: turn.role, content: turn.text })),
    { role: "user" as const, content: buildPrompt(request) },
  ];
}

/** postJson の結果。body は JSON として解釈できないとき undefined。 */
interface HttpResult {
  status: number;
  body: unknown;
}

/**
 * JSON を POST する。HTTP エラーも例外ではなく status として返す。
 * 本文の JSON 解析に失敗しても body: undefined で返し、失敗の判定は
 * 呼び出し側が status と合わせて行う（2xx で解析失敗は失敗。RULE-004）。
 */
async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<HttpResult> {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    // API キーを載せて送るため、リダイレクトの自動追跡はさせない（RULE-002）。
    // 転送先へキーごと送られると、意図しない相手へ渡る。
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { status: response.status, body: parsed };
}

function anthropicRequest(
  baseUrl: string,
  model: string,
  apiKey: string,
  messages: ChatMessage[],
): { url: string; headers: Record<string, string>; body: unknown } {
  return {
    url: `${baseUrl}/v1/messages`,
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: { model, max_tokens: MAX_OUTPUT_TOKENS, messages },
  };
}

function openaiRequest(
  baseUrl: string,
  model: string,
  apiKey: string,
  messages: ChatMessage[],
): { url: string; headers: Record<string, string>; body: unknown } {
  return {
    url: `${baseUrl}/v1/chat/completions`,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: { model, messages },
  };
}

/** 2xx 応答の本文から、生成されたテキストを取り出す。形が違えば undefined。 */
function extractText(vendor: ByokVendor, body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;

  if (vendor === "anthropic") {
    const content = (body as { content?: unknown }).content;
    if (!Array.isArray(content)) return undefined;
    const text = content
      .filter(
        (part): part is { type: "text"; text: string } =>
          typeof part === "object" &&
          part !== null &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text)
      .join("");
    return text ? text : undefined;
  }

  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return undefined;
  const message = (choices[0] as { message?: unknown } | undefined)?.message;
  const text = (message as { content?: unknown } | undefined)?.content;
  return typeof text === "string" && text ? text : undefined;
}

/** エラー応答の本文から、提供元が返したメッセージを取り出す。 */
function extractErrorMessage(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  // Anthropic / OpenAI とも { error: { message } } の形を返す。
  const message = ((body as { error?: unknown }).error as { message?: unknown } | undefined)
    ?.message;
  return typeof message === "string" && message ? message : undefined;
}

/** 「コンテキスト長超過」に相当するエラーか。 */
function isContextLengthError(status: number, body: unknown): boolean {
  if (status === 413) return true;
  if (typeof body === "object" && body !== null) {
    const error = (body as { error?: unknown }).error as
      { code?: unknown; type?: unknown } | undefined;
    // OpenAI は 400 + code、Anthropic は type: "request_too_large" で返す。
    if (error?.code === "context_length_exceeded" || error?.type === "request_too_large") {
      return true;
    }
  }
  return false;
}

/** HTTP の失敗を、呼び出し側が出し分けられる AIError へ写す。 */
function classifyHttpError(status: number, body: unknown): AIError {
  const providerMessage = extractErrorMessage(body);
  const suffix = providerMessage ? `: ${providerMessage}` : "";

  if (status === 401 || status === 403) {
    return {
      reason: "auth-failed",
      detail:
        `API キーが拒否されました（HTTP ${status}${suffix}）。` +
        "「Gakushu Sochi: BYOK の API キーを設定する」でキーを設定し直してください。",
    };
  }
  if (status === 404) {
    return {
      reason: "model-unavailable",
      detail:
        `指定したモデルが見つかりません（HTTP 404${suffix}）。` +
        "gakushuSochi.byok.model の値を確認してください。",
    };
  }
  if (status === 429) {
    return {
      reason: "rate-limited",
      detail: `提供元のレート制限に達しました（HTTP 429${suffix}）。しばらくしてから試してください。`,
    };
  }
  if (isContextLengthError(status, body)) {
    return {
      reason: "context-too-long",
      detail: `入力がモデルのコンテキスト長を超えました（HTTP ${status}${suffix}）。`,
    };
  }
  return { reason: "unknown", detail: `HTTP ${status}${suffix}` };
}

export class BYOKProvider implements AIProvider {
  readonly id = "byok";

  constructor(
    private readonly config: ByokProviderConfig,
    private readonly onDebug?: (message: string) => void,
    private readonly canSend: () => boolean = () => true,
  ) {}

  /** onDebug の失敗を質問処理へ波及させない（vscodeLm.ts と同じ方針）。 */
  private debug(message: string): void {
    try {
      this.onDebug?.(message);
    } catch {
      // 出力先が壊れている場合に報告する手段が無いため、ここは握って続行する。
    }
  }

  async ask(request: AIRequest): Promise<AIResponse> {
    const { vendor, apiKey } = this.config;

    if (!isByokVendor(vendor)) {
      return {
        ok: false,
        error: {
          reason: "model-unavailable",
          detail:
            `gakushuSochi.byok.vendor の値 "${vendor}" は未対応です。` +
            `${BYOK_VENDORS.join(" / ")} のいずれかを設定してください。`,
        },
      };
    }

    if (!apiKey) {
      return {
        ok: false,
        error: {
          reason: "model-unavailable",
          detail:
            "BYOK の API キーが未設定です。" +
            "コマンドパレットから「Gakushu Sochi: BYOK の API キーを設定する」を実行してください。",
        },
      };
    }

    const model = this.config.model?.trim() || DEFAULT_MODELS[vendor];
    const baseUrl = (this.config.baseUrl?.trim() || DEFAULT_BASE_URLS[vendor]).replace(/\/+$/, "");

    if (!isSafeByokBaseUrl(baseUrl)) {
      // キーを載せる前に弾く。平文 http の外部宛てへ送るとキーが盗聴される（RULE-003）。
      return {
        ok: false,
        error: {
          reason: "model-unavailable",
          detail: `BYOK の送信先 URL が安全ではありません（https、または localhost などのループバックのみ許可）: ${baseUrl}`,
        },
      };
    }

    // 同意の取り消しはキー読み出しの待機中にも起こりうる。コードを外へ出す
    // fetch の直前で再確認する（vscodeLm.ts の canSend と同じ責務）。
    if (!this.canSend()) {
      return {
        ok: false,
        error: { reason: "consent-denied", detail: "送信の同意が取り消されました。" },
      };
    }

    const messages = toChatMessages(request);
    const call =
      vendor === "anthropic"
        ? anthropicRequest(baseUrl, model, apiKey, messages)
        : openaiRequest(baseUrl, model, apiKey, messages);

    try {
      const result = await postJson(call.url, call.headers, call.body);

      if (result.status < 200 || result.status >= 300) {
        return { ok: false, error: classifyHttpError(result.status, result.body) };
      }

      const text = extractText(vendor, result.body);
      if (text === undefined) {
        // 2xx でも本文が読めないなら失敗である（RULE-004）。成功扱いにしない。
        return {
          ok: false,
          error: {
            reason: "unknown",
            detail: "応答本文を解釈できませんでした（成功応答の形式が想定と異なります）。",
          },
        };
      }

      this.debug(`--- AIの生の応答（byok: ${vendor}/${model}） ---\n${text}`);

      const parsed = parseAnswer(text);

      this.debug(
        `--- Concept抽出結果 ---\nconceptIds: ${JSON.stringify(parsed.conceptIds)}\nresolution: ${String(parsed.resolution)}`,
      );

      return {
        ok: true,
        answer: {
          text: parsed.text,
          conceptIds: parsed.conceptIds,
          mode: request.mode,
          model,
          ...(parsed.resolution ? { resolution: parsed.resolution } : {}),
        },
      };
    } catch (error) {
      // AbortSignal.timeout の TimeoutError もここへ来る。理由を残して unknown に倒す。
      return { ok: false, error: { reason: "unknown", detail: String(error) } };
    }
  }
}
