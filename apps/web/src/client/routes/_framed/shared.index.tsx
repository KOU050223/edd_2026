import { createFileRoute, Link } from "@tanstack/react-router";
import { fetchLearningMaps } from "../../learning-maps.js";
import { VISIBILITY_LABELS } from "../../map-sharing.js";
import { takeLoginRetry } from "../../session.js";

/**
 * 共有したマップの一覧（#302 の O1-c）。自分のマップのうち、共有しているものだけを出す。
 * 開くと、ほかの人に見えているのと同じ共有の版（`/shared/<ID>`）を見られる。
 * 手元と共有の版の差は出さない（O2-a。差は「共有の設定」の確認画面で見る）。
 */
function SharedMapList() {
  const { maps } = Route.useLoaderData();
  return (
    <>
      <p className="map-head">
        <Link to="/maps" className="link">
          ← 自分のマップ
        </Link>
        <h1>共有したマップ</h1>
      </p>
      <p className="muted">
        ほかの人に見えている版です。手元のマップを直しても、共有の設定で新しい版を上げるまで変わりません。
      </p>
      {maps.length === 0 ? (
        <p className="hint">
          まだ共有しているマップはありません。
          <Link to="/maps" className="link">
            自分のマップ
          </Link>
          を開いて「共有する」から共有できます。
        </p>
      ) : (
        <ul className="map-list">
          {maps.map((map) => (
            <li key={map.id} className="map-list-item">
              <Link to="/shared/$mapId" params={{ mapId: map.id }} className="map-list-link">
                <h2>{map.title}</h2>
                {map.description && <p className="muted">{map.description}</p>}
                <p className="muted">
                  {VISIBILITY_LABELS[map.visibility]}・版 {map.latestVersion}
                  {map.latestPublishedAt !== null &&
                    `・${new Date(map.latestPublishedAt).toLocaleString("ja-JP")} に上げた`}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export const Route = createFileRoute("/_framed/shared/")({
  // 共有の設定から戻ってきたとき、古い一覧を見せない。
  staleTime: 0,
  loader: async () => {
    const { maps } = await fetchLearningMaps(fetch, takeLoginRetry());
    // 共有しているもの（範囲が private 以外で、版がある）だけ。並びは自分のマップと同じ（更新の新しい順）。
    return {
      maps: maps.filter((map) => map.visibility !== "private" && map.latestVersion !== null),
    };
  },
  component: SharedMapList,
});
