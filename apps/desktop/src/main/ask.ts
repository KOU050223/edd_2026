// Managed AI への質問送信とストリーミング応答の読み取り
// （Issue #279 ステップ 3 で index.ts から分離）。
import { appState } from "./app-state.js";
import { describeApiFailure } from "./api-error.js";
import { refreshAccessTokenOrClearOnInvalidGrant } from "./auth/index.js";
import { parseOpenAIStream } from "./stream.js";
import { refreshTokenStore } from "./token-store.js";

/**
 * reader を cancel する後始末。中断の片付けの失敗で主処理を止めないが、
 * 失敗した理由は残す（RULE-004: 隔離しても飲み込まない）。
 */
function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  reader.cancel().catch((error: unknown) => {
    console.warn("応答ストリームの reader を cancel できませんでした", error);
  });
}

/** signal が既に abort 済みか、abort されたら reject する Promise を返す。 */
function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/**
 * SSE 応答本文を読み切り、行ごとに delta を流す。
 *
 * ストリームに壁時計タイムアウトは付けない（RULE-001 は単発 fetch のみ対象）。
 * 代わりに呼び出し側のライフサイクル（利用者のキャンセル・送信元の破棄）に
 * 紐づく signal で止める前提（RULE-005）。abort されると reader を cancel して
 * 上流の読み取りを切り、signal.reason を投げる。
 */
export async function readAnswerStream(
  response: Response,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!response.ok || !response.body) {
    // サーバーが返した error を捨てない。捨てると鍵の未設定もネットワーク不通も
    // 同じ文面になり、URL やトークンを疑わせる誤った誘導になる（RULE-004）。
    // 本文の読み取りも同じ signal の下に置き、中断中に待ち続けない。
    let body: unknown;
    try {
      body = JSON.parse(
        signal === undefined
          ? await response.text()
          : await Promise.race([response.text(), aborted(signal)]),
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      // 本文が JSON でないのは想定内。状態コードだけの文言へ落とす。
      body = undefined;
    }
    throw new Error(describeApiFailure(response.status, body));
  }
  const reader = response.body.getReader();
  const cancelOnAbort = () => cancelReader(reader);
  signal?.addEventListener("abort", cancelOnAbort, { once: true });
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      // abort 済みなら待たずに抜ける。abort → cancel で read() が解決する。
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (signal?.aborted) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      parseOpenAIStream(lines.join("\n"), onDelta);
    }
  } finally {
    signal?.removeEventListener("abort", cancelOnAbort);
    // 正常終了で残ったリーダーを残さない。既に cancel 済みなら no-op。
    cancelReader(reader);
    reader.releaseLock();
  }
  signal?.throwIfAborted();
  if (pending) parseOpenAIStream(pending, onDelta);
}

export async function askManagedAI(
  selection: string,
  question: string,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const generation = appState.authOperation.current();
  if (appState.authOperation.isLoginInProgress()) {
    throw new Error("ログイン中は更新できません。");
  }
  const refreshToken = refreshTokenStore().get();
  if (!refreshToken) throw new Error("ログインが必要です。設定からログインしてください。");
  const refreshed = await refreshAccessTokenOrClearOnInvalidGrant(refreshToken, generation);
  if (!appState.authOperation.isCurrent(generation)) {
    throw new Error("認証状態が変更されたため、更新結果を破棄しました。");
  }
  if (refreshed.refreshToken) refreshTokenStore().set(refreshed.refreshToken);
  const apiToken = refreshed.accessToken;
  const response = await fetch(
    `${appState.settings.apiBaseUrl.replace(/\/$/, "")}/v1/ai/responses`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      // リダイレクトを自動追跡しない。転送先へ Authorization ヘッダごと送られると、
      // トークンが意図しない相手に渡る（.agents/rules/rules.md RULE-002）。
      redirect: "error",
      signal: signal ?? null,
      body: JSON.stringify({
        selection,
        question,
        model: appState.settings.model,
        temperature: appState.settings.temperature,
        maxTokens: appState.settings.maxTokens,
        // 空文字は送らない。サーバーは省略と空文字を同じ「未設定」に正規化するが、
        // 送る側でも未設定はキー自体を落としておく。
        ...(appState.settings.persona.trim() ? { persona: appState.settings.persona.trim() } : {}),
      }),
    },
  );
  await readAnswerStream(response, onDelta, signal);
}
