import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { ApiError, requestJson } from "../../api.js";
import { LearningMapPage } from "../../learning-map-page.js";
import { parseConceptSearch, type MapProfile } from "../../learning-map-view.js";
import { fetchLearningMap } from "../../learning-maps.js";
import { fetchSharedMap } from "../../map-sharing.js";
import type { MasteryOverrides } from "../../overrides.js";
import { takeLoginRetry } from "../../session.js";

/**
 * 持ち主が、自分の共有の版をほかの人と同じ表示で見る（#302 の O1-c）。
 * 手元のマップを直しても、新しい版を上げるまでここは変わらない。
 */
function SharedVersionPage() {
  const { mapId } = Route.useParams();
  const { loaded, profile, overrides } = Route.useLoaderData();
  const { concept } = Route.useSearch();
  const navigate = useNavigate();
  return (
    <LearningMapPage
      mapId={mapId}
      loaded={loaded}
      profile={profile}
      overrides={overrides}
      selectedId={concept}
      shareKey={undefined}
      onSelectInMap={(conceptId) =>
        void navigate({ to: "/shared/$mapId", params: { mapId }, search: { concept: conceptId } })
      }
    />
  );
}

/** 「無い」（404）なら `null`。それ以外の失敗（セッション切れなど）はそのまま投げる。 */
function nullIfNotFound(error: unknown): null {
  if (error instanceof ApiError && error.kind === "not_found") return null;
  throw error;
}

export const Route = createFileRoute("/_framed/shared/$mapId")({
  validateSearch: (search: Record<string, unknown>): { concept?: string } =>
    parseConceptSearch(search),
  // 共有の設定で新しい版を上げて戻ってきたとき、古い版を見せない。
  staleTime: 0,
  // 手元のマップ（持ち主か・鍵）と共有の版と習熟度は1つの結果にまとめる（RULE-005）。
  loader: async ({ params }) => {
    const retry = takeLoginRetry();
    const [own, shared, profile, overrides] = await Promise.all([
      fetchLearningMap(params.mapId, fetch, retry).catch(nullIfNotFound),
      fetchSharedMap(params.mapId, undefined, fetch, retry).catch(nullIfNotFound),
      requestJson<MapProfile>("/api/v1/learning-profile", fetch, retry),
      requestJson<MasteryOverrides>("/api/v1/mastery-overrides", fetch, retry),
    ]);
    // 自分のマップでない、または共有していない（やめた）なら、ふつうのマップの画面で開く。
    // そちらが他人の共有マップの表示か、404 を出す。
    if (own === null || shared === null || !shared.isOwner) {
      // TanStack Router の遷移は throw で行う。
      throw redirect({ to: "/maps/$mapId", params: { mapId: params.mapId } });
    }
    return {
      loaded: { kind: "shared" as const, map: shared, ownShareKey: own.shareKey },
      profile,
      overrides,
    };
  },
  component: SharedVersionPage,
});
