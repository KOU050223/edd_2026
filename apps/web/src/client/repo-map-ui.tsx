/**
 * リポジトリからのマップ（#249）の画面で共有する部品。
 * 判断は `repo-maps.ts`（jsdom 無しでテストできる側）に置き、ここは描画と状態の受け渡しだけを持つ。
 */

import { useState } from "react";
import { ApiError } from "./api.js";
import { changeGenerationConsent } from "./check.js";
import type { CheckGenerationConsent } from "./check.js";
import { toErrorText } from "./errors.js";
import { MAP_GENERATION_CONSENT_PATH } from "./map-generation.js";
import {
  EVIDENCE_KIND_LABELS,
  RepoMapConsentRequiredError,
  RepoMapError,
  type RepoMapEvidenceKind,
} from "./repo-maps.js";

/** 失敗を画面向けの文にする。API が文を添えていればそれを使う。 */
export function repoMapErrorText(error: unknown): string {
  if (error instanceof RepoMapError) return error.detail;
  return toErrorText(error);
}

/** ログイン切れなら、ログインへ戻して true を返す。 */
export function redirectIfSessionExpired(error: unknown): boolean {
  if (error instanceof ApiError && error.kind === "session_expired") {
    window.location.href = "/login";
    return true;
  }
  return false;
}

export function isConsentRequired(error: unknown): error is RepoMapConsentRequiredError {
  return error instanceof RepoMapConsentRequiredError;
}

/**
 * AI へ送る内容への同意の流れ（マップの生成と同じ記録・同じ文面）。
 * 「今後表示しない」を選ぶとサーバーに記録して次回から出さない。取り消しは設定画面。
 */
export function useConsentFlow(initial: CheckGenerationConsent) {
  const [consent, setConsent] = useState(initial);
  const [pending, setPending] = useState<((consentVersion: number | undefined) => void) | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  return {
    consent,
    asking: pending !== null,
    saving,
    error,
    /** 同意の記録があればそのまま実行し、無ければ先に送る内容を示す。 */
    request(run: (consentVersion: number | undefined) => void) {
      if (consent.granted) {
        run(undefined);
        return;
      }
      setError(undefined);
      setPending(() => run);
    },
    /** API が「同意が要る」と返した（文面の版が変わった・記録が取り消された）。 */
    required(version: number, run: (consentVersion: number | undefined) => void) {
      setConsent({ version, granted: false });
      setError(undefined);
      setPending(() => run);
    },
    agree(remember: boolean) {
      if (pending === null || saving) return;
      const run = pending;
      const version = consent.version;
      if (!remember) {
        setPending(null);
        run(version);
        return;
      }
      setSaving(true);
      setError(undefined);
      changeGenerationConsent({ grant: version }, fetch, MAP_GENERATION_CONSENT_PATH)
        .then((saved) => {
          setConsent(saved);
          setPending(null);
          run(version);
        })
        .catch((value: unknown) => {
          if (redirectIfSessionExpired(value)) return;
          setError(toErrorText(value));
        })
        .finally(() => setSaving(false));
    },
    cancel() {
      setPending(null);
    },
  };
}

/** 根拠 1 件のリンク（commit SHA で固定したリンクへ）。 */
export function EvidenceLink({
  kind,
  label,
  url,
}: {
  kind: RepoMapEvidenceKind;
  label: string;
  url: string;
}) {
  return (
    <a href={url} target="_blank" rel="noreferrer noopener" className="link">
      {EVIDENCE_KIND_LABELS[kind]}: {label}
    </a>
  );
}
