import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { ApiError, createSubmitGuard } from "../../api.js";
import { toErrorText } from "../../errors.js";
import { fetchLearningMap } from "../../learning-maps.js";
import { MapContentList } from "../../map-content-view.js";
import {
  describeSummary,
  fetchMapVersion,
  fetchMapVersions,
  restoreMapVersion,
  shareConflictText,
  ShareConflictError,
  type SharedMapContentView,
} from "../../map-sharing.js";
import { takeLoginRetry } from "../../session.js";

function failureText(value: unknown): string | undefined {
  if (value instanceof ApiError && value.kind === "session_expired") {
    window.location.href = "/login";
    return undefined;
  }
  return value instanceof ShareConflictError ? shareConflictText(value) : toErrorText(value);
}

/**
 * 共有の版の履歴と復元（Issue #244 の決定 T2）。持ち主だけが開ける。
 *
 * 復元は過去の版の中身で新しい版を作り、手元のマップもその中身に戻す。履歴は書き換えない。
 * 取り込んだ人には新しい版として届く。
 */
function HistoryPage() {
  const { mapId } = Route.useParams();
  const { map, versions } = Route.useLoaderData();
  const router = useRouter();
  const [opened, setOpened] = useState<{ version: number; content: SharedMapContentView }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const guard = useRef(createSubmitGuard());
  // 中身を続けて開いたとき、古い応答で新しい表示を上書きしない（RULE-005）。
  const latestRequest = useRef(0);
  const latest = versions[0]?.version;

  const open = (version: number) => {
    if (opened?.version === version) {
      setOpened(undefined);
      return;
    }
    const request = ++latestRequest.current;
    setError(undefined);
    fetchMapVersion(mapId, version).then(
      ({ content }) => {
        if (request === latestRequest.current) setOpened({ version, content });
      },
      (value: unknown) => {
        if (request === latestRequest.current) setError(failureText(value));
      },
    );
  };

  const restore = (version: number) => {
    // 送信中は入口で弾く（RULE-007）。
    if (guard.current.isRunning("restore") || latest === undefined) return;
    if (
      !window.confirm(
        `版 ${String(version)} の中身で新しい版（版 ${String(latest + 1)}）を作り、手元のマップもその中身に戻します。` +
          "手元で直して、まだ共有へ上げていない分は消えます。",
      )
    )
      return;
    setError(undefined);
    setMessage(undefined);
    setBusy(true);
    void guard.current
      .run("restore", async () => {
        try {
          const restored = await restoreMapVersion(mapId, version, latest);
          setMessage(
            `版 ${String(version)} から復元し、版 ${String(restored.version.version)} を作りました。`,
          );
          setOpened(undefined);
          await router.invalidate();
        } catch (value: unknown) {
          setError(failureText(value));
          if (value instanceof ShareConflictError) await router.invalidate();
        }
      })
      .finally(() => setBusy(false));
  };

  return (
    <>
      <p className="map-head">
        <Link to="/maps/$mapId" params={{ mapId }} className="link">
          ← マップへ戻る
        </Link>
        <h1>版の履歴: {map.title}</h1>
      </p>
      {message && (
        <p className="message saved" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {versions.length === 0 ? (
        <p className="hint">
          まだ共有へ上げていません。
          <Link to="/maps/$mapId/share" params={{ mapId }} className="link">
            共有の設定
          </Link>
          から中身を確かめて共有すると、版が残ります。
        </p>
      ) : (
        <ol className="version-list">
          {versions.map((version) => (
            <li key={version.version}>
              <p>
                <strong>版 {version.version}</strong>
                {version.version === latest && <span className="muted">（共有している版）</span>}
                <span className="muted">
                  {" "}
                  {new Date(version.createdAt).toLocaleString("ja-JP")}
                </span>
              </p>
              <p className="muted">
                {version.restoredFrom === null
                  ? describeSummary(version.summary)
                  : `版 ${String(version.restoredFrom)} から復元（${describeSummary(version.summary)}）`}
                {version.checksIncluded ? "" : "・確認問題は含めていない"}
              </p>
              <div className="actions">
                <button type="button" className="link" onClick={() => open(version.version)}>
                  {opened?.version === version.version ? "中身を閉じる" : "中身を見る"}
                </button>
                {version.version !== latest && (
                  <button type="button" disabled={busy} onClick={() => restore(version.version)}>
                    この版に戻す
                  </button>
                )}
              </div>
              {opened?.version === version.version && <MapContentList content={opened.content} />}
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

export const Route = createFileRoute("/_framed/maps/$mapId_/history")({
  staleTime: 0,
  // 題名と版の一覧は1つの結果にまとめる（RULE-005）。
  loader: async ({ params }) => {
    const retry = takeLoginRetry();
    const [map, { versions }] = await Promise.all([
      fetchLearningMap(params.mapId, fetch, retry),
      fetchMapVersions(params.mapId, fetch, retry),
    ]);
    return { map, versions };
  },
  component: HistoryPage,
});
