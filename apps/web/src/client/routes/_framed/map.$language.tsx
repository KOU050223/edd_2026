import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import {
  ConceptDetail,
  LINKS,
  loadLearningMap,
  languageLabel,
  NARROW_LAYOUT,
  nameOf,
  overlaidConcepts,
  parseConceptSearch,
  SkillTree,
  TREES,
  useGoToConcept,
  useMasteryChange,
} from "../../learning-map-view.js";
import { findCurrentPosition, summarizeTree } from "../../learning-map.js";

/**
 * 1 領域ぶんの Skill Tree。ノードを選ぶと `?concept=` 付きの URL へ遷移し、
 * 右のパネルに詳細を出す。選択が URL に載るので、共有や再読み込みで同じ詳細が開く。
 */
function LanguageMap() {
  const { language } = Route.useParams();
  const { profile, overrides } = Route.useLoaderData();
  // 未ログインでは profile が無い。地図の形は見せたまま、記録や修正の導線だけを畳む。
  const loggedIn = profile !== null;
  const { concept: selectedId } = Route.useSearch();
  const router = useRouter();
  const navigate = useNavigate();
  const { saveError, pending, changeStatus } = useMasteryChange();
  const goToConcept = useGoToConcept();
  const detail = useRef<HTMLElement>(null);

  const conceptList = overlaidConcepts(profile, overrides);
  const concepts = new Map(conceptList.map((concept) => [concept.conceptId, concept]));
  const current = findCurrentPosition(conceptList);
  const nextIds = current === undefined ? [] : (LINKS.get(current)?.next ?? []);
  const next = new Set(nextIds);
  const tree = TREES.find((candidate) => candidate.language === language);
  const inTree = (conceptId: string | undefined) =>
    conceptId !== undefined && tree?.nodes.some((node) => node.conceptId === conceptId) === true;
  // `?concept=` が無ければ、この木にある現在地を開いておく。現在地が別領域ならパネルは出さない。
  const selected =
    selectedId === undefined
      ? inTree(current)
        ? concepts.get(current!)
        : undefined
      : concepts.get(selectedId);

  const select = (conceptId: string) => {
    void navigate({
      to: "/map/$language",
      params: { language },
      search: { concept: conceptId },
    });
  };

  // 狭い画面では詳細が地図の下に回るので、選んだことが見えるところまで送る。
  const selectedConceptId = selected?.conceptId;
  useEffect(() => {
    if (selectedConceptId === undefined) return;
    if (window.matchMedia(NARROW_LAYOUT).matches)
      detail.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [selectedConceptId]);

  if (tree === undefined) {
    return (
      <section className="message">
        <p>「{language}」という領域はありません。</p>
        <Link to="/">項目一覧へ戻る</Link>
      </section>
    );
  }
  const summary = summarizeTree(tree, concepts);
  const currentConcept = current === undefined ? undefined : concepts.get(current);
  return (
    <>
      <p className="map-head">
        <Link to="/" className="link">
          ← 項目一覧
        </Link>
        <h1>{languageLabel[language] ?? language}</h1>
        {tree.nodes.some((node) => node.conceptId === current) && <em className="badge">現在地</em>}
      </p>
      <section className="summary" aria-label={`${languageLabel[language] ?? language} の集計`}>
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
      {saveError && (
        <section className="message error">
          <p>理解度の保存に失敗しました：{saveError}</p>
        </section>
      )}
      {!loggedIn && (
        // 最初に開く人がまず見る画面（Issue #182）。地図の形はログイン無しで
        // 見せ、記録の開始点としてログインへの導線を置く。
        <p className="hint">
          学習の進み具合を記録・表示するには<a href="/login">ログイン</a>してください。
        </p>
      )}
      <section className="position" aria-label="現在地と次に学ぶ候補">
        {currentConcept ? (
          <>
            <div>
              <span className="muted">現在地</span>
              <button className="link" onClick={() => goToConcept(currentConcept.conceptId)}>
                {nameOf(currentConcept)}
              </button>
            </div>
            <div>
              <span className="muted">次に学ぶ候補</span>
              {nextIds.length === 0 ? (
                <span>この先に続く Concept はありません</span>
              ) : (
                nextIds.map((id) => {
                  const concept = concepts.get(id);
                  return (
                    <button className="link" key={id} onClick={() => goToConcept(id)}>
                      {concept ? nameOf(concept) : id}
                    </button>
                  );
                })
              )}
            </div>
          </>
        ) : (
          <span className="muted">学習中の Concept はまだありません</span>
        )}
      </section>
      <div className={selected ? "map-layout" : undefined}>
        <div className="map">
          <SkillTree
            tree={tree}
            concepts={concepts}
            current={current}
            next={next}
            selected={selected?.conceptId}
            onSelect={select}
          />
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
      {profile && (
        <footer>
          {profile.eventCount} 件のイベントから導出 ·{" "}
          {new Date(profile.derivedAt).toLocaleString("ja-JP")}
        </footer>
      )}
    </>
  );
}

export const Route = createFileRoute("/_framed/map/$language")({
  validateSearch: parseConceptSearch,
  loader: loadLearningMap,
  component: LanguageMap,
});
