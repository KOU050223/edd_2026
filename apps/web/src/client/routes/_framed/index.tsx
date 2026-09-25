import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { suggestNextConcepts } from "@gakushu-sochi/domain";
import type { ConceptFamiliarity, MasteryStatusView } from "@gakushu-sochi/domain";
import {
  AREAS,
  ConceptDetail,
  LINKS,
  loadLearningMap,
  languageLabel,
  NARROW_LAYOUT,
  nameOf,
  overlaidConcepts,
  parseConceptSearch,
  TREES,
  useGoToConcept,
  useMasteryChange,
} from "../../learning-map-view.js";
import { findCurrentPosition, summarizeTree } from "../../learning-map.js";

/**
 * 項目一覧。領域ごとのカードを並べ、詳しい地図は `/map/$language` へ譲る。
 * 地図に載らない Concept だけはここから直接詳細を開ける（`?concept=`）。
 */
function AreaIndex() {
  const { profile, overrides } = Route.useLoaderData();
  // 未ログインでは profile が無い。地図の形は見せたまま、記録や修正の導線だけを畳む。
  const loggedIn = profile !== null;
  const { concept: selectedId } = Route.useSearch();
  const { saveError, pending, changeStatus } = useMasteryChange();
  const goToConcept = useGoToConcept();
  const detail = useRef<HTMLElement>(null);

  // 未ログインでは観測も上書きも無いので、全部が未観測の地図になる。
  const conceptList = overlaidConcepts(profile, overrides);
  const concepts = new Map(conceptList.map((concept) => [concept.conceptId, concept]));
  const current = findCurrentPosition(conceptList);
  const selected = selectedId === undefined ? undefined : concepts.get(selectedId);
  // 定義から外れた Concept の観測は地図に載らない。件数だけ数えて見えなくすると
  // 記録が消えたように見えるので、一覧の下に並べて選べるようにする（RULE-004）。
  const unmapped = conceptList.filter((concept) => !AREAS.has(concept.conceptId));

  // 外部履歴の形跡があるのに確認されていない Concept を「次に学ぶ候補」にする
  // （Issue #157）。履歴は Mastery へは混ぜず、候補の提示にだけ使う。
  const nextCandidates = suggestNextConcepts({
    familiarity: Object.fromEntries(
      (profile?.familiarity ?? []).map((entry) => [entry.conceptId, entry]),
    ) as Record<string, ConceptFamiliarity | undefined>,
    // 手動修正を反映した status（conceptList）を見る。自動算出のままだと
    // 「確認済みに直した Concept」が候補に残ってしまう。
    mastery: Object.fromEntries(
      conceptList.map((concept) => [concept.conceptId, { status: concept.status }]),
    ) as Record<string, MasteryStatusView | undefined>,
  }).filter((id) => concepts.has(id));

  // 狭い画面では詳細が一覧の下に回るので、選んだことが見えるところまで送る。
  const selectedConceptId = selected?.conceptId;
  useEffect(() => {
    if (selectedConceptId === undefined) return;
    if (window.matchMedia(NARROW_LAYOUT).matches)
      detail.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [selectedConceptId]);

  return (
    <>
      {!loggedIn && (
        // 最初に開く人がまず見る画面（Issue #182）。項目の形はログイン無しで
        // 見せ、記録の開始点としてログインへの導線を置く。
        <p className="hint">
          学習の進み具合を記録・表示するには<a href="/login">ログイン</a>してください。
        </p>
      )}
      {saveError && (
        <section className="message error">
          <p>理解度の保存に失敗しました：{saveError}</p>
        </section>
      )}
      {loggedIn && profile.eventCount === 0 && (
        <p className="hint">
          まだ学習データがありません。学習を始めると、この地図に現在地が現れます。
        </p>
      )}
      <div className={selected ? "map-layout" : undefined}>
        <div className="areas">
          {TREES.map((tree) => {
            const summary = summarizeTree(tree, concepts);
            const hasCurrent = tree.nodes.some((node) => node.conceptId === current);
            return (
              <Link
                key={tree.language}
                to="/map/$language"
                params={{ language: tree.language }}
                className="area-card"
              >
                <h2>
                  {languageLabel[tree.language] ?? tree.language}
                  {hasCurrent && <em className="badge">現在地</em>}
                </h2>
                <div className="area-progress" aria-hidden="true">
                  <i
                    className="confirmed"
                    style={{ width: `${(summary.confirmed / summary.total) * 100}%` }}
                  />
                  <i
                    className="learning"
                    style={{ width: `${(summary.learning / summary.total) * 100}%` }}
                  />
                </div>
                <p className="area-counts">
                  確認済み {summary.confirmed}・学習中 {summary.learning}・未観測{" "}
                  {summary.unobserved}
                </p>
              </Link>
            );
          })}
        </div>
        {selected && (
          <ConceptDetail
            concept={selected}
            links={LINKS.get(selected.conceptId)}
            concepts={concepts}
            isCurrent={selected.conceptId === current}
            pending={pending.includes(selected.conceptId)}
            loggedIn={loggedIn}
            onChange={(status) => changeStatus(selected.conceptId, status)}
            onSelect={goToConcept}
            panel={detail}
          />
        )}
      </div>
      {nextCandidates.length > 0 && (
        <section className="position" aria-label="次に学ぶ候補">
          <span className="muted">過去の履歴から、次に学ぶ候補</span>
          {nextCandidates.map((id) => {
            const concept = concepts.get(id);
            return (
              <button className="link" key={id} onClick={() => goToConcept(id)}>
                {concept ? nameOf(concept) : id}
              </button>
            );
          })}
        </section>
      )}
      {unmapped.length > 0 && (
        <section className="position unmapped" aria-label="地図に無い Concept">
          <span className="muted">地図に無い Concept</span>
          {unmapped.map((concept) => (
            <button
              className="link"
              key={concept.conceptId}
              onClick={() => goToConcept(concept.conceptId)}
            >
              {nameOf(concept)}
            </button>
          ))}
        </section>
      )}
      {profile && (
        <footer>
          {profile.eventCount} 件のイベントから導出 ·{" "}
          {new Date(profile.derivedAt).toLocaleString("ja-JP")}
        </footer>
      )}
    </>
  );
}

export const Route = createFileRoute("/_framed/")({
  validateSearch: parseConceptSearch,
  loader: loadLearningMap,
  component: AreaIndex,
});
