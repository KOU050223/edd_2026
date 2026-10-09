import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { ApiError, createSubmitGuard } from "../../api.js";
import { toErrorText } from "../../errors.js";
import { MapContentList, MapDiffList } from "../../map-content-view.js";
import type { ShareScope } from "../../learning-maps.js";
import {
  fetchPublishPreview,
  publishLearningMap,
  setMapVisibility,
  shareConflictText,
  ShareConflictError,
  VISIBILITY_LABELS,
  type MapPublishPreview,
} from "../../map-sharing.js";
import { takeLoginRetry } from "../../session.js";

/** 失敗を画面の文にする。セッション切れはログインへ送る。 */
function failureText(value: unknown): string | undefined {
  if (value instanceof ApiError && value.kind === "session_expired") {
    window.location.href = "/login";
    return undefined;
  }
  return value instanceof ShareConflictError ? shareConflictText(value) : toErrorText(value);
}

/**
 * 共有へ上げる前の確認画面（Issue #244 の決定 S1-a）。
 *
 * 共有へ切り替えるとき・新しい版を上げるときは、必ずここを通す。出ていく中身
 * （ノードの表示名・概要・「理解すること」と、作成時の確認問題）を全部並べ（2回目以降は差分を先に）、
 * 「この内容を共有する」を押したときだけ上がる。手元のマップは上げるまで共有の側に出ない（T1-a）。
 */
function SharePage() {
  const { mapId } = Route.useParams();
  const loaded = Route.useLoaderData();
  const navigate = useNavigate();
  const router = useRouter();
  const [preview, setPreview] = useState<MapPublishPreview>(loaded);
  const [scope, setScope] = useState<ShareScope>(
    loaded.visibility === "private" ? "link" : loaded.visibility,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const guard = useRef(createSubmitGuard());
  // 確認問題を含めるかを切り替えるたびに読み直す。古い応答で新しい表示を上書きしない（RULE-005）。
  const latestRequest = useRef(0);

  const reload = async (includeChecks: boolean) => {
    const request = ++latestRequest.current;
    const next = await fetchPublishPreview(mapId, includeChecks);
    if (request === latestRequest.current) setPreview(next);
  };

  const toggleChecks = (includeChecks: boolean) => {
    if (guard.current.isRunning("share")) return;
    setError(undefined);
    setBusy(true);
    void guard.current
      .run("share", async () => {
        try {
          await reload(includeChecks);
        } catch (value: unknown) {
          setError(failureText(value));
        }
      })
      .finally(() => setBusy(false));
  };

  const publish = () => {
    // 送信中は入口で弾く（RULE-007）。
    if (guard.current.isRunning("share")) return;
    setError(undefined);
    setBusy(true);
    void guard.current
      .run("share", async () => {
        try {
          await publishLearningMap(mapId, {
            visibility: scope,
            includeChecks: preview.includeChecks,
            baseVersion: preview.latest?.version ?? null,
            contentHash: preview.contentHash,
          });
          await navigate({ to: "/maps/$mapId", params: { mapId } });
        } catch (value: unknown) {
          setError(failureText(value));
          // 中身や版が変わっていたら、今の中身を見せ直す（確かめていない中身を上げさせない）。
          if (value instanceof ShareConflictError) {
            await reload(preview.includeChecks).catch((reloadError: unknown) =>
              setError(failureText(reloadError)),
            );
          }
        }
      })
      .finally(() => setBusy(false));
  };

  /** 範囲だけを変える（中身は前の版のまま）。`private` で共有をやめる。 */
  const changeVisibility = (visibility: "private" | ShareScope) => {
    if (guard.current.isRunning("share")) return;
    if (
      visibility === "private" &&
      !window.confirm(
        "共有をやめます。ほかの人はこのマップを読めなくなります。取り込み済みの人のマップはそのまま残ります。",
      )
    )
      return;
    setError(undefined);
    setBusy(true);
    void guard.current
      .run("share", async () => {
        try {
          await setMapVisibility(mapId, visibility);
          await router.invalidate();
          await navigate({ to: "/maps/$mapId", params: { mapId } });
        } catch (value: unknown) {
          setError(failureText(value));
        }
      })
      .finally(() => setBusy(false));
  };

  const shared = preview.visibility !== "private";
  const scopeChanged = shared && scope !== preview.visibility;

  return (
    <>
      <p className="map-head">
        <Link to="/maps/$mapId" params={{ mapId }} className="link">
          ← マップへ戻る
        </Link>
        <h1>共有の設定</h1>
      </p>
      <section className="message">
        <p>
          今の範囲: <strong>{VISIBILITY_LABELS[preview.visibility]}</strong>
          {preview.latest && (
            <>
              （共有している版 {preview.latest.version}・
              {new Date(preview.latest.createdAt).toLocaleString("ja-JP")}）
            </>
          )}
        </p>
        <p className="muted">
          共有すると、選んだ範囲の人が下の中身を読めます。手で書いた表示名・概要・「理解すること」に、
          個人的な内容が入っていないか確かめてください。共有へ上げたあとに手元を直しても、
          もう一度ここで上げるまで共有の側は変わりません。
        </p>
      </section>

      <fieldset className="share-scope" disabled={busy}>
        <legend>共有の範囲</legend>
        {(["link", "public"] as const).map((value) => (
          <label key={value}>
            <input
              type="radio"
              name="scope"
              checked={scope === value}
              onChange={() => setScope(value)}
            />
            {VISIBILITY_LABELS[value]}
          </label>
        ))}
      </fieldset>

      {preview.availableChecks > 0 && (
        <label className="share-include-checks">
          <input
            type="checkbox"
            checked={preview.includeChecks}
            disabled={busy}
            onChange={(event) => toggleChecks(event.target.checked)}
          />
          マップを作るときに作った確認問題（{preview.availableChecks} 組）を共有に含める
        </label>
      )}

      {preview.latest === null ? (
        <section>
          <h2>共有に出ていく中身</h2>
          <MapContentList content={preview.content} />
        </section>
      ) : (
        <>
          <section>
            <h2>版 {preview.latest.version} からの変更</h2>
            <MapDiffList diff={preview.diff} content={preview.content} />
          </section>
          <details>
            <summary>共有に出ていく中身の全部</summary>
            <MapContentList content={preview.content} />
          </details>
        </>
      )}

      <div className="actions">
        {preview.hasChanges ? (
          <button type="button" disabled={busy} onClick={publish}>
            {busy ? "処理しています…" : "この内容を共有する"}
          </button>
        ) : (
          <p className="muted">共有している版から中身が変わっていません。</p>
        )}
        {!preview.hasChanges && scopeChanged && (
          <button type="button" disabled={busy} onClick={() => changeVisibility(scope)}>
            範囲だけを「{VISIBILITY_LABELS[scope]}」に変える
          </button>
        )}
        {!shared && !preview.hasChanges && preview.latest !== null && (
          <button type="button" disabled={busy} onClick={() => changeVisibility(scope)}>
            版 {preview.latest.version} のまま共有を再開する
          </button>
        )}
        {shared && (
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => changeVisibility("private")}
          >
            共有をやめる
          </button>
        )}
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

export const Route = createFileRoute("/_framed/maps/$mapId_/share")({
  // 編集から戻ってきたとき、古い中身で確かめさせない。
  staleTime: 0,
  loader: ({ params }) => fetchPublishPreview(params.mapId, undefined, fetch, takeLoginRetry()),
  component: SharePage,
});
