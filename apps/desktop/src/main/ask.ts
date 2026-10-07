// Managed AI への質問送信とストリーミング応答の読み取り
// （Issue #279 ステップ 3 で index.ts から分離）。
import { appState } from "./app-state.js";
import { describeApiFailure } from "./api-error.js";
import { refreshAccessTokenOrClearOnInvalidGrant } from "./auth/index.js";
import { parseOpenAIStream } from "./stream.js";
import { refreshTokenStore } from "./token-store.js";

export async function askManagedAI(
  selection: string,
  question: string,
  onDelta: (text: string) => void,
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
  if (!response.ok || !response.body) {
    // サーバーが返した error を捨てない。捨てると鍵の未設定もネットワーク不通も
    // 同じ文面になり、URL やトークンを疑わせる誤った誘導になる（RULE-004）。
    let body: unknown;
    try {
      body = JSON.parse(await response.text());
    } catch {
      // 本文が JSON でないのは想定内。状態コードだけの文言へ落とす。
      body = undefined;
    }
    throw new Error(describeApiFailure(response.status, body));
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  for (;;) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    parseOpenAIStream(lines.join("\n"), onDelta);
    if (done) break;
  }
  if (pending) parseOpenAIStream(pending, onDelta);
}
