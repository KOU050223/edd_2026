// API のエラー応答を利用者向けの文言にする。index.ts から切り出してあるのは、
// electron を読み込まずに変換規則だけをテストするため。

/**
 * 失敗応答の本文から `error` を取り出す。
 *
 * API は失敗時に `{ error: string }` を返す（`apps/api/src/app.ts`、
 * `routes/ai.ts`）。取り出せないときは undefined を返し、呼び出し側が
 * 状態コードだけの文言へ落とせるようにする。
 */
export function readApiErrorDetail(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const detail = (body as { error?: unknown }).error;
  return typeof detail === "string" && detail.trim().length > 0 ? detail.trim() : undefined;
}

/**
 * 利用上限に達した応答から、利用者へそのまま出せる説明を取り出す。
 *
 * サーバーは上限到達時に `message`（日本語の説明）と `resetAt`（回復時刻）を返す
 * （`apps/api/src/contract/ai-usage.ts` の `AiUsageLimitBody`）。これを読まないと、
 * 429 が「API URL と設定内容を確認してください」という**無関係な案内**になり、
 * 利用者は設定を疑って時間を使う。上限は設定の誤りではないので、
 * サーバーが用意した文面を優先して見せる。
 */
function readUsageLimitMessage(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const message = (body as { message?: unknown }).message;
  return typeof message === "string" && message.trim().length > 0 ? message.trim() : undefined;
}

/**
 * 失敗応答を利用者が次の一手を選べる文言にする。
 *
 * サーバーが返した `error` を捨てない。捨てると、鍵の未設定（503）も
 * ネットワーク不通も同じ文面になり、URL やトークンを疑わせる誤った誘導になる
 * （.agents/rules/rules.md RULE-004: フォールバックで失敗を隠さない）。
 */
export function describeApiFailure(status: number, body: unknown): string {
  // 上限到達は「失敗」ではあるが、利用者にとっては設定の問題ではない。
  // サーバーが回復時刻まで含めた文面を用意しているので、それを本文にする。
  const limitMessage = status === 429 ? readUsageLimitMessage(body) : undefined;
  if (limitMessage !== undefined) return limitMessage;

  const detail = readApiErrorDetail(body);
  const hint = hintFor(status);
  return [
    `API サービスへの応答が失敗しました (${status})。`,
    detail ? `サーバーの応答: ${detail}` : "サーバーは詳細を返しませんでした。",
    hint,
  ]
    .filter(Boolean)
    .join(" ");
}

function hintFor(status: number): string {
  if (status === 401 || status === 403) return "設定からログインし直してください。";
  // 上限到達で message が無いのは、AI の利用上限ではなくレート制限（頻度）のとき。
  // 設定を疑わせないよう、待てば直ることを伝える。
  if (status === 429) return "短時間に要求が集中しました。少し待ってから試してください。";
  if (status === 503)
    return "API 側で AI の資格情報が設定されていない可能性があります（apps/api の GEMINI_API_KEY）。";
  if (status === 502) return "API の上流（AI プロバイダ）が応答しませんでした。";
  if (status >= 500) return "API 側の問題です。しばらく待って試してください。";
  return "API URL と設定内容を確認してください。";
}
