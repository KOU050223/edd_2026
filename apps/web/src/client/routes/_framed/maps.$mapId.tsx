import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ApiError, createSubmitGuard, requestJson } from "../../api.js";
import { toErrorText } from "../../errors.js";
import {
  ConceptDetail,
  NARROW_LAYOUT,
  overlaidConcepts,
  parseConceptSearch,
  SkillTree,
  useGoToConcept,
  useMasteryChange,
  type MapProfile,
} from "../../learning-map-view.js";
import {
  findCurrentPosition,
  layoutTrees,
  linkConcepts,
  summarizeTree,
} from "../../learning-map.js";
import { fetchLearningMap, mapDefinitions } from "../../learning-maps.js";
import {
  CreationChecksError,
  creationChecksSummary,
  generateCreationChecks,
  MAP_GENERATION_COST,
} from "../../map-generation.js";
import type { MasteryOverrides } from "../../overrides.js";
import { takeLoginRetry } from "../../session.js";

/**
 * AI で作ったマップの作成時の確認問題（#247）。生成の画面で作れなかったときや、
 * 途中で画面を離れたときに、ここから作れるようにする。作成済みなら何も出さない。
 */
function CreationChecksPanel({
  mapId,
  status,
}: {
  mapId: string;
  status: "pending" | "exhausted";
}) {
  const router = useRouter();
  const guard = useRef(createSubmitGuard());
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  const run = () => {
    // 送信中は入口で弾く（RULE-007）。
    if (guard.current.isRunning("checks")) return;
    setError(undefined);
    setMessage(undefined);
    setRunning(true);
    void guard.current
      .run("checks", async () => {
        try {
          setMessage(creationChecksSummary(await generateCreationChecks(mapId)));
          await router.invalidate();
        } catch (value: unknown) {
          if (value instanceof ApiError && value.kind === "session_expired") {
            window.location.href = "/login";
            return;
          }
          setError(value instanceof CreationChecksError ? value.detail : toErrorText(value));
          // 頼める回数が尽きたかどうかは、読み直した状態で出し分ける。
          await router.invalidate();
        }
      })
      .finally(() => setRunning(false));
  };

  if (status === "exhausted") {
    return (
      <section className="message">
        <p>
          このマップの作成時の確認問題は作れませんでした。問題は各ノードの確認問題の画面から1組ずつ作れます。
        </p>
        {error && <p className="error-text">{error}</p>}
      </section>
    );
  }
  return (
    <section className="message">
      <p>
        このマップの確認問題はまだ作っていません。手前のノードから最大 10 組を作ります（AI
        の利用回数を {MAP_GENERATION_COST} 回使います）。
      </p>
      <div className="actions">
        <button type="button" disabled={running} onClick={run}>
          {running ? "確認問題を作っています…" : "確認問題を作る"}
        </button>
      </div>
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
    </section>
  );
}

/**
 * 手で作った学習マップ1件の表示（Issue #242）。言語別マップ（`/map/$language`）と同じ
 * `SkillTree` と詳細パネルを使う。ノードを選ぶと `?concept=` 付きの URL へ遷移する。
 */
function LearningMapPage() {
  const { mapId } = Route.useParams();
  const { map, profile, overrides } = Route.useLoaderData();
  const { concept: selectedId } = Route.useSearch();
  const router = useRouter();
  const navigate = useNavigate();
  const { saveError, pending, changeStatus } = useMasteryChange();
  const goToConcept = useGoToConcept();
  const detail = useRef<HTMLElement>(null);

  const defined = mapDefinitions(map);
  const conceptList = overlaidConcepts(profile, overrides, defined.concepts);
  const concepts = new Map(conceptList.map((concept) => [concept.conceptId, concept]));
  // このマップのノードだけで現在地を探す。他の領域の Concept を現在地にしない。
  const inMap = new Set(defined.concepts.map((concept) => concept.id));
  const current = findCurrentPosition(
    conceptList.filter((concept) => inMap.has(concept.conceptId)),
  );
  const links = linkConcepts(defined.concepts);
  const nextIds = current === undefined ? [] : (links.get(current)?.next ?? []);
  const next = new Set(nextIds);
  // ノードが無いマップでは木が無い。
  const tree = layoutTrees(defined.concepts)[0];
  const definitionOf = new Map(defined.concepts.map((concept) => [concept.id, concept]));
  const nodeOf = new Map(map.nodes.map((node) => [node.conceptId, node]));

  const selectedNodeId =
    selectedId !== undefined && inMap.has(selectedId)
      ? selectedId
      : current !== undefined && inMap.has(current)
        ? current
        : undefined;
  const selected = selectedNodeId === undefined ? undefined : concepts.get(selectedNodeId);
  const selectedNode = selectedNodeId === undefined ? undefined : nodeOf.get(selectedNodeId);

  // マップの中の選択は同じ画面のまま。前提・次の Concept もこのマップのノードなので、ここで選ぶ。
  const select = (conceptId: string) => {
    if (!inMap.has(conceptId)) {
      goToConcept(conceptId);
      return;
    }
    void navigate({ to: "/maps/$mapId", params: { mapId }, search: { concept: conceptId } });
  };

  // 狭い画面では詳細が地図の下に回るので、選んだことが見えるところまで送る。
  const selectedConceptId = selected?.conceptId;
  useEffect(() => {
    if (selectedConceptId === undefined) return;
    if (window.matchMedia(NARROW_LAYOUT).matches)
      detail.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [selectedConceptId]);

  const summary = tree === undefined ? undefined : summarizeTree(tree, concepts);

  // 参照のノードは、元の Concept の表示名・概要・項目をそのまま出す（このマップでは書き換えない）。
  const referenceNote = (() => {
    if (selectedNode?.kind !== "reference") return undefined;
    if (selectedNode.origin === null) {
      return "参照していた元の Concept が見つかりません。元のマップかノードが削除されています。";
    }
    return "既存の Concept を参照しています。表示名・概要・「理解すること」は元のものです。";
  })();

  return (
    <>
      <p className="map-head">
        <Link to="/maps" className="link">
          ← 自分のマップ
        </Link>
        <h1>{map.title}</h1>
        {/* 編集はノードごとではなくマップ単位（まとめて保存する）なので、そう書く。 */}
        <Link to="/maps/$mapId/edit" params={{ mapId }} className="link">
          マップを編集
        </Link>
      </p>
      {map.description && <p className="muted">{map.description}</p>}
      {map.creationChecks !== undefined && map.creationChecks.status !== "done" && (
        <CreationChecksPanel mapId={mapId} status={map.creationChecks.status} />
      )}
      {summary && (
        <section className="summary" aria-label={`${map.title} の集計`}>
          <div>
            <strong>{summary.confirmed}</strong>確認済み
          </div>
          <div>
            <strong>{summary.learning}</strong>学習中
          </div>
          <div>
            <strong>{summary.unobserved}</strong>未観測
          </div>
          <button onClick={() => router.invalidate()} disabled={pending.length > 0}>
            再読み込み
          </button>
        </section>
      )}
      {saveError && (
        <section className="message error">
          <p>理解度の保存に失敗しました：{saveError}</p>
        </section>
      )}
      {tree === undefined ? (
        <p className="hint">
          このマップにはまだノードがありません。
          <Link to="/maps/$mapId/edit" params={{ mapId }} className="link">
            マップを編集
          </Link>
          からノードを足してください。
        </p>
      ) : (
        <div className={selected ? "map-layout" : undefined}>
          <div className="map">
            <SkillTree
              tree={tree}
              title={map.title}
              concepts={concepts}
              current={current}
              next={next}
              selected={selected?.conceptId}
              onSelect={select}
            />
          </div>
          {selected && selectedNode && (
            <ConceptDetail
              concept={selected}
              summary={definitionOf.get(selected.conceptId)?.summary}
              objectives={defined.objectives.filter(
                (objective) => objective.conceptId === selected.conceptId,
              )}
              note={referenceNote}
              fromMapId={mapId}
              links={links.get(selected.conceptId)}
              concepts={concepts}
              isCurrent={selected.conceptId === current}
              pending={pending.includes(selected.conceptId)}
              // マップの画面はログインしないと開けない。
              loggedIn
              onChange={(status) => changeStatus(selected.conceptId, status)}
              onSelect={select}
              panel={detail}
            />
          )}
        </div>
      )}
    </>
  );
}

export const Route = createFileRoute("/_framed/maps/$mapId")({
  validateSearch: parseConceptSearch,
  // 編集や確認問題から戻ってきたとき、古い中身を見せない。
  staleTime: 0,
  // マップと習熟度は1つの結果にまとめる。片方だけ古い組み合わせを出さない（RULE-005）。
  loader: async ({ params }) => {
    const retry = takeLoginRetry();
    const [map, profile, overrides] = await Promise.all([
      fetchLearningMap(params.mapId, fetch, retry),
      requestJson<MapProfile>("/api/v1/learning-profile", fetch, retry),
      requestJson<MasteryOverrides>("/api/v1/mastery-overrides", fetch, retry),
    ]);
    return { map, profile, overrides };
  },
  component: LearningMapPage,
});
