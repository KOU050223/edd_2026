import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ApiError, createSubmitGuard } from "../../../api.js";
import {
  deleteEvidenceByProvider,
  deleteLearningData,
  exportFileName,
  fetchImportSessions,
  fetchLearningDataExport,
  undoImportSession,
  type DeleteLearningDataResult,
  type ImportSessionView,
} from "../../../learning-data.js";
import { historySourceLabel } from "../../../learning-map.js";
import { toErrorText } from "../../../errors.js";
import { takeLoginRetry } from "../../../session.js";

/**
 * ダウンロードは object URL を経由する。Web は学習データのコピーを持たない
 * （docs/data-privacy.md「クライアント側に残るコピー」）ため、取得した値は
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
 * （docs/data-privacy.md「クライアント側に残るコピー」）。
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

      <ImportSessionsCard />
    </section>
  );
}

/**
 * 履歴インポートの管理（Issue #157）。
 *
 * 「どのソースのデータが残っているか」を見せ、Import 単位の Undo と
 * ソース単位の削除を提供する。取り込み自体はデスクトップアプリが担う。
 */
function ImportSessionsCard() {
  const router = useRouter();
  const submitGuard = useRef(createSubmitGuard());
  const [sessions, setSessions] = useState<ImportSessionView[]>();
  const [loadError, setLoadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [confirmProvider, setConfirmProvider] = useState<string>();

  const reload = () => {
    fetchImportSessions(fetch, takeLoginRetry())
      .then(setSessions)
      .catch((value: unknown) => {
        if (value instanceof ApiError && value.kind === "login_required") return;
        setLoadError(toErrorText(value));
      });
  };

  // 設定画面を開いたタイミングで一度だけ取る。一覧は操作ごとに取り直す。
  useEffect(reload, []);

  const providers = [...new Set((sessions ?? []).flatMap((session) => session.providers))].sort();

  const undo = (id: string) => {
    if (submitGuard.current.isRunning(`undo:${id}`)) return;
    setActionError(undefined);
    void submitGuard.current.run(`undo:${id}`, async () => {
      try {
        await undoImportSession(fetch, id);
        reload();
        await router.invalidate();
      } catch (value: unknown) {
        if (value instanceof ApiError && value.kind === "session_expired") {
          window.location.href = "/login";
          return;
        }
        setActionError(toErrorText(value));
      }
    });
  };

  const deleteProvider = (provider: string) => {
    if (submitGuard.current.isRunning(`provider:${provider}`)) return;
    setActionError(undefined);
    void submitGuard.current.run(`provider:${provider}`, async () => {
      try {
        await deleteEvidenceByProvider(fetch, provider);
        setConfirmProvider(undefined);
        reload();
        await router.invalidate();
      } catch (value: unknown) {
        if (value instanceof ApiError && value.kind === "session_expired") {
          window.location.href = "/login";
          return;
        }
        setActionError(toErrorText(value));
      }
    });
  };

  if (loadError) {
    return (
      <article className="plan-card">
        <h3>履歴インポート</h3>
        <p className="error-text" role="alert">
          取り込み履歴を取得できませんでした：{loadError}
        </p>
      </article>
    );
  }

  return (
    <article className="plan-card">
      <h3>履歴インポート</h3>
      <p className="muted">
        デスクトップアプリが取り込んだ外部 AI の学習履歴の記録です。 Import を取り消すと、その
        Import で追加された観測がすべて取り除かれます。
      </p>
      {sessions === undefined ? (
        <p className="muted">読み込み中…</p>
      ) : sessions.length === 0 ? (
        <p className="muted">取り込まれた履歴はありません。</p>
      ) : (
        <ul>
          {sessions.map((session) => (
            <li key={session.id}>
              {new Date(session.createdAt).toLocaleString("ja-JP")}・
              {session.providers.map(historySourceLabel).join("・")}・観測 {session.evidenceCount}{" "}
              件・
              {session.status === "applied"
                ? "適用済み"
                : session.status === "undone"
                  ? "取り消し済み"
                  : session.status}
              {session.status === "applied" && (
                <>
                  {" "}
                  <button type="button" className="link" onClick={() => undo(session.id)}>
                    取り消す
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {providers.length > 0 && (
        <>
          <h4>ソース単位の削除</h4>
          <ul>
            {providers.map((provider) => (
              <li key={provider}>
                {historySourceLabel(provider)}{" "}
                {confirmProvider === provider ? (
                  <>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => deleteProvider(provider)}
                    >
                      本当に削除する
                    </button>{" "}
                    <button
                      type="button"
                      className="link"
                      onClick={() => setConfirmProvider(undefined)}
                    >
                      やめる
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="link"
                    onClick={() => setConfirmProvider(provider)}
                  >
                    このソースのデータを削除
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {actionError && (
        <p className="error-text" role="alert">
          操作に失敗しました：{actionError}
        </p>
      )}
    </article>
  );
}

export const Route = createFileRoute("/_framed/settings/data")({
  component: DataSettings,
});
