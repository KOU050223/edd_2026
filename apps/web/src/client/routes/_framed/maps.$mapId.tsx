import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { ApiError, requestJson } from "../../api.js";
import { LearningMapPage, type LoadedMap } from "../../learning-map-page.js";
import { parseConceptSearch, type MapProfile } from "../../learning-map-view.js";
import { fetchLearningMap, findOwnMapOf } from "../../learning-maps.js";
import { fetchSharedMap } from "../../map-sharing.js";
import type { MasteryOverrides } from "../../overrides.js";
import { loadRepoMapSources } from "../../repo-maps.js";
import { takeLoginRetry } from "../../session.js";

/** `/maps/<ID>`。ノードを選ぶと `?concept=` を変える。 */
function MapRoutePage() {
  const { mapId } = Route.useParams();
  const { loaded, profile, overrides, sources } = Route.useLoaderData();
  const { concept, key } = Route.useSearch();
  const navigate = useNavigate();
  return (
    <LearningMapPage
      mapId={mapId}
      loaded={loaded}
      profile={profile}
      overrides={overrides}
      sources={sources}
      selectedId={concept}
      shareKey={key}
      // 「リンクだけ」の鍵は選び直しても持ち続ける（外すと読み直しで 404 になる）。
      onSelectInMap={(conceptId) =>
        void navigate({
          to: "/maps/$mapId",
          params: { mapId },
          search: { concept: conceptId, key },
        })
      }
    />
  );
}

/**
 * 自分のマップなら手元のマップ、そうでなければ共有の側の版を読む（#244 の T5・U1。「リンクだけ」の
 * リンクは `/maps/<マップ ID>?key=<鍵>`）。自分のマップでも、読める共有マップでもなければ、
 * 共有の側の 404 をそのまま返す。
 */
async function loadMap(
  mapId: string,
  search: { concept?: string; key?: string },
  retry: boolean | number,
): Promise<LoadedMap> {
  try {
    return { kind: "own", map: await fetchLearningMap(mapId, fetch, retry) };
  } catch (error: unknown) {
    if (!(error instanceof ApiError && error.kind === "not_found")) throw error;
  }
  // 取り込んだマップのノードは元のマップの ID を前半に持つ（#244 で ID を引き継ぐ）。別の画面から
  // そのノードを選ぶと元のマップの ID でここへ来るので、自分のノードを持つマップがあればそちらへ移る。
  if (search.concept !== undefined) {
    const own = await findOwnMapOf(search.concept, fetch, retry);
    if (own !== undefined && own !== mapId) {
      // TanStack Router の遷移は throw で行う。
      throw redirect({
        to: "/maps/$mapId",
        params: { mapId: own },
        search: { concept: search.concept },
      });
    }
  }
  return { kind: "shared", map: await fetchSharedMap(mapId, search.key, fetch, retry) };
}

export const Route = createFileRoute("/_framed/maps/$mapId")({
  // `key` は「リンクだけ」の共有の鍵（#244 の決定 U1）。
  validateSearch: (search: Record<string, unknown>): { concept?: string; key?: string } => ({
    ...parseConceptSearch(search),
    ...(typeof search.key === "string" ? { key: search.key } : {}),
  }),
  loaderDeps: ({ search }) => ({ key: search.key }),
  // 編集や確認問題から戻ってきたとき、古い中身を見せない。
  staleTime: 0,
  // マップと習熟度は1つの結果にまとめる。片方だけ古い組み合わせを出さない（RULE-005）。
  // `concept` は依存に入れない（ノードを選ぶたびに読み直さない）。取り込んだノードの行き先を
  // 決めるのに、開いたときの値だけを使う。
  loader: async ({ params, deps, location }) => {
    const retry = takeLoginRetry();
    const { concept } = parseConceptSearch(location.search as Record<string, unknown>);
    const loadedPromise = loadMap(params.mapId, { key: deps.key, concept }, retry);
    const [loaded, profile, overrides, sources] = await Promise.all([
      loadedPromise,
      requestJson<MapProfile>("/api/v1/learning-profile", fetch, retry),
      requestJson<MasteryOverrides>("/api/v1/mastery-overrides", fetch, retry),
      // 根拠は、自分のマップのときだけ読む（マップの読み込みと並べて、直列の 1 回を増やさない）。
      loadedPromise.then((value) =>
        loadRepoMapSources(params.mapId, value.kind === "own", fetch, retry),
      ),
    ]);
    return { loaded, profile, overrides, sources };
  },
  component: MapRoutePage,
});
