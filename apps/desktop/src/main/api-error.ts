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
 * 失敗応答を利用者が次の一手を選べる文言にする。
 *
 * サーバーが返した `error` を捨てない。捨てると、鍵の未設定（503）も
 * ネットワーク不通も同じ文面になり、URL やトークンを疑わせる誤った誘導になる
 * （.agents/rules/rules.md RULE-004: フォールバックで失敗を隠さない）。
 */
export function describeApiFailure(status: number, body: unknown): string {
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
  if (status === 503)
    return "API 側で AI の資格情報が設定されていない可能性があります（apps/api の GEMINI_API_KEY）。";
  if (status === 502) return "API の上流（AI プロバイダ）が応答しませんでした。";
  if (status >= 500) return "API 側の問題です。しばらく待って試してください。";
  return "API URL と設定内容を確認してください。";
}
