import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { ApiError, createSubmitGuard } from "../../api.js";
import { toErrorText } from "../../errors.js";
import { deleteLearningMap, fetchLearningMaps, MAP_LIMITS } from "../../learning-maps.js";
import { takeLoginRetry } from "../../session.js";

/**
 * 自分が手で作った学習マップの一覧（Issue #242）。マップは最初は作成者だけのもの。
 *
 * 作成と編集は編集画面で行う（#242 の後続）。ここでは一覧・表示への導線・削除を持つ。
 */
function MapList() {
  const { maps } = Route.useLoaderData();
  const router = useRouter();
  const [deleting, setDeleting] = useState<string>();
  const [deleteError, setDeleteError] = useState<string>();
  const submitGuard = useRef(createSubmitGuard());

  const remove = (mapId: string, title: string) => {
    // 送信中は入口で弾く（RULE-007）。
    if (submitGuard.current.isRunning(mapId)) return;
    if (
      !window.confirm(
        `「${title}」を削除します。ノード・「理解すること」と、そのノードで作った確認問題も消えます。` +
          "学習の記録は残ります。",
      )
    )
      return;
    setDeleteError(undefined);
    setDeleting(mapId);
    void submitGuard.current
      .run(mapId, async () => {
        try {
          await deleteLearningMap(mapId);
          await router.invalidate();
        } catch (error: unknown) {
          if (error instanceof ApiError && error.kind === "session_expired") {
            window.location.href = "/login";
            return;
          }
          // 削除の失敗を黙って飲み込まない（RULE-004）。
          setDeleteError(toErrorText(error));
        }
      })
      .finally(() => setDeleting(undefined));
  };

  return (
    <>
      <p className="map-head">
        <Link to="/" className="link">
          ← 項目一覧
        </Link>
        <h1>自分のマップ</h1>
        <span className="muted">
          {maps.length} / {MAP_LIMITS.maps}
        </span>
      </p>
      {deleteError && (
        <section className="message error">
          <p>マップの削除に失敗しました：{deleteError}</p>
        </section>
      )}
      {maps.length === 0 ? (
        <p className="hint">まだマップがありません。</p>
      ) : (
        <ul className="map-list">
          {maps.map((map) => (
            <li key={map.id} className="map-list-item">
              <Link to="/maps/$mapId" params={{ mapId: map.id }} className="map-list-link">
                <h2>{map.title}</h2>
                {map.description && <p className="muted">{map.description}</p>}
                <p className="muted">
                  {map.nodeCount} ノード・更新 {new Date(map.updatedAt).toLocaleDateString("ja-JP")}
                </p>
              </Link>
              <button
                className="link danger"
                disabled={deleting === map.id}
                onClick={() => remove(map.id, map.title)}
              >
                {deleting === map.id ? "削除中…" : "削除"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export const Route = createFileRoute("/_framed/maps/")({
  // 作成・削除のあとに戻ってきたとき、古い一覧を見せない。
  staleTime: 0,
  loader: () => fetchLearningMaps(fetch, takeLoginRetry()),
  component: MapList,
});
