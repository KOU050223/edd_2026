/**
 * 読み込み失敗の表示。ルートの `errorComponent` から使う。
 *
 * loader が投げた値がここへ来る。再試行は `router.invalidate()` で行い、
 * loader の再実行とエラー境界の解除を同時に起こす。
 */

import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { ApiError } from "./api.js";

const errorText: Record<ApiError["kind"], string> = {
  session_expired: "ログインの有効期限が切れました",
  auth_unavailable: "認証サーバーへ一時的に接続できません。少し待って再試行してください。",
  rate_limited: "短時間に要求が多すぎます。しばらく待って再読み込みしてください。",
  consent_required:
    "送信の同意がありません。設定画面の「送信の同意」で内容を確認して同意してください。",
  consent_outdated:
    "同意の文面が更新されました。ページを再読み込みして、最新の内容を確認してください。",
  unavailable: "学習データの取得に失敗しました",
};

/** 失敗を利用者向けの文面にする。見覚えのない失敗は握りつぶさず既定の文面で出す（RULE-004）。 */
export function toErrorText(error: unknown): string {
  return error instanceof ApiError ? errorText[error.kind] : errorText.unavailable;
}

export function ErrorPanel({ error }: { error: unknown }) {
  const router = useRouter();
  const expired = error instanceof ApiError && error.kind === "session_expired";
  useEffect(() => {
    if (expired)
      window.setTimeout(() => {
        window.location.href = "/login";
      }, 500);
  }, [expired]);
  return (
    <section className="message error">
      <p>{toErrorText(error)}</p>
      {!expired && <button onClick={() => router.invalidate()}>再試行</button>}
    </section>
  );
}

export function Pending() {
  return <p className="message">読み込み中…</p>;
}
