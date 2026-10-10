import { createFileRoute, Link } from "@tanstack/react-router";
import { fetchSharedMaps } from "../../map-sharing.js";
import { takeLoginRetry } from "../../session.js";

/**
 * みんなのマップ（#305 の P1-a）。ほかの人が範囲「全員」で共有したマップを、新しく上げた順に
 * 最大 50 件出す。自分のマップは API が除く（P3-a。自分のものは「共有したマップ」で見る）。
 * 「リンクだけ」のマップは鍵がアクセス制御なので出さない（P2-a）。
 * 開くと `/maps/<ID>` で共有の版を読めて、自分のマップに取り込める（#244）。
 */
function ExploreMaps() {
  const { maps } = Route.useLoaderData();
  return (
    <>
      <p className="map-head">
        <Link to="/maps" className="link">
          ← 自分のマップ
        </Link>
        <h1>みんなのマップ</h1>
      </p>
      <p className="muted">
        ほかの人が全員に共有したマップです。開いて読み、気に入ったら自分のマップに取り込めます。
      </p>
      {maps.length === 0 ? (
        <p className="hint">ほかの人が全員に共有したマップは、まだありません。</p>
      ) : (
        <ul className="map-list">
          {maps.map((map) => (
            <li key={map.id} className="map-list-item">
              <Link to="/maps/$mapId" params={{ mapId: map.id }} className="map-list-link">
                <h2>{map.title}</h2>
                {map.description && <p className="muted">{map.description}</p>}
                <p className="muted">
                  {map.nodeCount} ノード・版 {map.version}・
                  {new Date(map.publishedAt).toLocaleDateString("ja-JP")}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export const Route = createFileRoute("/_framed/explore/")({
  // 取り込んだあとに戻ってきたとき、古い一覧を見せない。
  staleTime: 0,
  loader: () => fetchSharedMaps(fetch, takeLoginRetry(), { excludeOwn: true }),
  component: ExploreMaps,
});
