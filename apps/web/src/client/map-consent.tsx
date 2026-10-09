/**
 * マップの AI 生成の同意の確認（#243）。マップの生成の画面と、フォークの公開の確認問題（#246 の V4-a）で使う。
 */

import { MAP_GENERATION_NOTICE } from "@gakushu-sochi/domain";
import { useState } from "react";

/**
 * 生成の前に、AI へ送る内容を示して同意を取る（確認問題と同じ形、#243 の決定 3）。
 * 「今後表示しない」を選ぶと、サーバーに記録して次回から出さない。取り消しは設定画面。
 */
export function ConsentPrompt({
  saving,
  error,
  onAgree,
  onCancel,
  agreeLabel = "同意して作る",
}: {
  agreeLabel?: string;
  saving: boolean;
  error: string | undefined;
  onAgree: (remember: boolean) => void;
  onCancel: () => void;
}) {
  const [remember, setRemember] = useState(false);
  return (
    <div className="check-consent" role="dialog" aria-label="AI へ送る内容の確認">
      {MAP_GENERATION_NOTICE.split("\n").map((line) => (
        <p key={line}>{line}</p>
      ))}
      <label className="check-consent-remember">
        <input
          type="checkbox"
          checked={remember}
          onChange={(event) => setRemember(event.target.checked)}
        />
        今後表示しない（設定の「学習データ」から取り消せます）
      </label>
      <div className="actions">
        <button type="button" disabled={saving} onClick={() => onAgree(remember)}>
          {agreeLabel}
        </button>
        <button type="button" className="secondary" disabled={saving} onClick={onCancel}>
          やめる
        </button>
      </div>
      {error && (
        <p className="error-text" role="alert">
          同意を記録できませんでした：{error}
        </p>
      )}
    </div>
  );
}
