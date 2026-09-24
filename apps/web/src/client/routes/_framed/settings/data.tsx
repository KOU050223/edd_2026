import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { ApiError, createSubmitGuard } from "../../../api.js";
import {
  deleteLearningData,
  exportFileName,
  fetchLearningDataExport,
  type DeleteLearningDataResult,
} from "../../../learning-data.js";
import { toErrorText } from "../../../errors.js";
import { takeLoginRetry } from "../../../session.js";

/**
 * ダウンロードは object URL を経由する。Web は学習データのコピーを持たない
 * （docs/architecture.md「クライアント側に残るコピー」）ため、取得した値は
 * ファイルへ流すだけで、画面やストレージへ残さない。
 */
function downloadJson(payload: unknown, fileName: string) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  // click() の直後に revoke すると、ブラウザによってはダウンロードが
  // 始まる前に URL が無効になる。開始を待ってから解放する。
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * 学習データのエクスポートと削除（Issue #173）。
 *
 * 削除は取り消せないため、実行の前に画面内で確認を挟む。
 * Web から消せるのはサーバー側だけで、他の端末に残るコピーは
 * それぞれの端末が次回の同期で追従して消す
 * （docs/architecture.md「クライアント側に残るコピー」）。
 */
function DataSettings() {
  const router = useRouter();
  const submitGuard = useRef(createSubmitGuard());
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string>();
  const [exported, setExported] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  const [deleted, setDeleted] = useState<DeleteLearningDataResult>();

  const runExport = () => {
    // 入口で弾く（RULE-007）。`disabled` は見た目でしかない。
    if (submitGuard.current.isRunning("export")) return;
    setExportError(undefined);
    setExported(false);
    setExporting(true);
    void submitGuard.current
      .run("export", async () => {
        try {
          const profile = await fetchLearningDataExport(fetch, takeLoginRetry());
          downloadJson(profile, exportFileName(new Date()));
          setExported(true);
        } catch (value: unknown) {
          // 失敗を黙って飲み込まない（RULE-004）。
          if (value instanceof ApiError && value.kind === "session_expired") {
            window.location.href = "/login";
            return;
          }
          setExportError(toErrorText(value));
        }
      })
      .finally(() => {
        setExporting(false);
      });
  };

  const runDelete = () => {
    if (submitGuard.current.isRunning("delete")) return;
    setDeleteError(undefined);
    setDeleted(undefined);
    setDeleting(true);
    void submitGuard.current
      .run("delete", async () => {
        try {
          const result = await deleteLearningData(fetch);
          setDeleted(result);
          setConfirmingDelete(false);
          // **loader のキャッシュも捨てる。** 学習イベントを消したあとに地図へ
          // 戻ると、キャッシュが残っていれば削除前の習熟度が見える（RULE-005）。
          await router.invalidate();
        } catch (value: unknown) {
          if (value instanceof ApiError && value.kind === "session_expired") {
            window.location.href = "/login";
            return;
          }
          setDeleteError(toErrorText(value));
        }
      })
      .finally(() => {
        setDeleting(false);
      });
  };

  return (
    <section>
      <h2>学習データ</h2>
      <article className="plan-card">
        <h3>エクスポート</h3>
        <p className="muted">
          サーバーに保存されている学習イベントと、そこから導出した習熟度を JSON
          ファイルでダウンロードします。
        </p>
        <div className="actions">
          <button type="button" disabled={exporting} onClick={runExport}>
            {exporting ? "取得中…" : "ダウンロード"}
          </button>
        </div>
        {exportError && (
          <p className="error-text" role="alert">
            学習データを取得できませんでした：{exportError}
          </p>
        )}
        {exported && !exportError && (
          <p className="message saved" role="status">
            ダウンロードしました
          </p>
        )}
      </article>

      <article className="plan-card">
        <h3>削除</h3>
        <p className="muted">
          サーバー上の学習イベントと習熟度をすべて削除します。アカウント、設定、手動で変更した理解度は残ります。
          VS Code 拡張など他の端末に残っているコピーは、その端末が次回同期したときに削除されます。
        </p>
        {confirmingDelete ? (
          <div className="confirm-delete">
            <p>
              <strong>本当に削除しますか？</strong>
              この操作は取り消せません。
            </p>
            <div className="actions">
              <button type="button" className="danger" disabled={deleting} onClick={runDelete}>
                {deleting ? "削除中…" : "削除する"}
              </button>
              <button type="button" disabled={deleting} onClick={() => setConfirmingDelete(false)}>
                やめる
              </button>
            </div>
          </div>
        ) : (
          <div className="actions">
            <button
              type="button"
              className="danger"
              onClick={() => {
                setDeleteError(undefined);
                setDeleted(undefined);
                setConfirmingDelete(true);
              }}
            >
              学習データを削除する
            </button>
          </div>
        )}
        {deleteError && (
          <p className="error-text" role="alert">
            学習データを削除できませんでした：{deleteError}
          </p>
        )}
        {deleted && (
          <p className="message saved" role="status">
            学習データを削除しました（{deleted.deletedCount} 件のイベント）
          </p>
        )}
      </article>
    </section>
  );
}

export const Route = createFileRoute("/_framed/settings/data")({
  component: DataSettings,
});
