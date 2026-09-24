import { CONCEPTS } from "@gakushu-sochi/domain";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState, type RefObject } from "react";
import {
  ApiError,
  createOperationQueue,
  createSubmitGuard,
  putJson,
  requestJson,
} from "../../api.js";
import {
  applyOverrides,
  MASTERY_STATUSES,
  type MasteryOverrides,
  type MasteryStatus,
  type OverlaidConcept,
} from "../../overrides.js";
import { summarizeConcepts, type Concept } from "../../profile.js";
import {
  completeConcepts,
  findCurrentPosition,
  layoutTrees,
  linkConcepts,
  type ConceptLinks,
  type MapTree,
} from "../../learning-map.js";
import { toErrorText } from "../../errors.js";
import { takeLoginRetry } from "../../session.js";

type Profile = { derivedAt: string; eventCount: number; concepts: Concept[] };

const OVERRIDES_PATH = "/api/v1/mastery-overrides";

// Concept の定義は描画のたびに変わらないので、接続と配置はモジュールの読み込み時に一度だけ作る。
const LINKS = linkConcepts(CONCEPTS);
const TREES = layoutTrees(CONCEPTS);

const statusLabel: Record<MasteryStatus, string> = {
  confirmed: "確認済み",
  learning: "学習中",
  unobserved: "未観測",
};

/** 1 つの Concept の理解度を手動で選び直す。送信中は入口で弾く（RULE-007）。 */
function MasteryPicker({
  concept,
  pending,
  onChange,
}: {
  concept: OverlaidConcept;
  pending: boolean;
  onChange: (status: MasteryStatus | null) => void;
}) {
  return (
    <div className="mastery-edit">
      <label>
        理解度を修正
        <select
          value={concept.status}
          disabled={pending}
          onChange={(event) => onChange(event.target.value as MasteryStatus)}
        >
          {MASTERY_STATUSES.map((status) => (
            <option value={status} key={status}>
              {statusLabel[status]}
            </option>
          ))}
        </select>
      </label>
      {concept.manual && (
        <button className="link" disabled={pending} onClick={() => onChange(null)}>
          自動算出（{statusLabel[concept.derived.status]}）へ戻す
        </button>
      )}
    </div>
  );
}

const languageLabel: Record<string, string> = { go: "Go", ts: "TypeScript" };

// 地図の寸法（px）。ノードは固定の大きさの箱で、列は前提の段数、行は木の葉の順。
const NODE_WIDTH = 150;
const NODE_HEIGHT = 48;
const COLUMN_GAP = 24;
const ROW_GAP = 12;
const nodeX = (depth: number) => depth * (NODE_WIDTH + COLUMN_GAP);
const nodeY = (row: number) => row * (NODE_HEIGHT + ROW_GAP);

// style.css で詳細パネルを地図の下へ回す幅。値を揃えること。
const NARROW_LAYOUT = "(max-width: 600px)";

const nameOf = (concept: OverlaidConcept) => concept.label ?? concept.conceptId;
const percent = (score: number | null) => (score === null ? "—" : `${Math.round(score * 100)}%`);

/** 1 言語ぶんの Skill Tree。Map 内には Concept 名と状態だけを出し、詳細は右のパネルへ回す。 */
function SkillTree({
  tree,
  concepts,
  current,
  next,
  selected,
  onSelect,
}: {
  tree: MapTree;
  concepts: ReadonlyMap<string, OverlaidConcept>;
  current: string | undefined;
  next: ReadonlySet<string>;
  selected: string | undefined;
  onSelect: (conceptId: string) => void;
}) {
  const width = nodeX(tree.depths - 1) + NODE_WIDTH;
  const height = nodeY(tree.rows - 1) + NODE_HEIGHT;
  const position = new Map(tree.nodes.map((node) => [node.conceptId, node]));
  const scroller = useRef<HTMLDivElement>(null);
  const currentDepth = current === undefined ? undefined : position.get(current)?.depth;
  // 画面が狭く木が横にはみ出すときは、現在地が見える位置まで木の中だけを横に送る。
  useEffect(() => {
    const element = scroller.current;
    if (!element || currentDepth === undefined) return;
    element.scrollLeft = Math.max(
      0,
      nodeX(currentDepth) + NODE_WIDTH / 2 - element.clientWidth / 2,
    );
  }, [currentDepth]);
  return (
    <section className="tree">
      <h2>{languageLabel[tree.language] ?? tree.language}</h2>
      <div className="tree-scroll" ref={scroller}>
        <div className="tree-canvas" style={{ width, height }}>
          <svg width={width} height={height} aria-hidden="true">
            {tree.edges.map((edge) => {
              const from = position.get(edge.from);
              const to = position.get(edge.to);
              if (!from || !to) return null;
              const x1 = nodeX(from.depth) + NODE_WIDTH;
              const y1 = nodeY(from.row) + NODE_HEIGHT / 2;
              const x2 = nodeX(to.depth);
              const y2 = nodeY(to.row) + NODE_HEIGHT / 2;
              const bend = (x2 - x1) / 2;
              const state =
                edge.from === current && next.has(edge.to)
                  ? "edge next"
                  : concepts.get(edge.from)?.status === "confirmed"
                    ? "edge done"
                    : "edge";
              return (
                <path
                  key={`${edge.from}->${edge.to}`}
                  className={state}
                  d={`M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`}
                />
              );
            })}
          </svg>
          {tree.nodes.map((node) => {
            const concept = concepts.get(node.conceptId);
            if (!concept) return null;
            const isCurrent = node.conceptId === current;
            const classes = [
              "node",
              isCurrent ? "current" : concept.status,
              next.has(node.conceptId) && "next",
              node.conceptId === selected && "selected",
            ].filter(Boolean);
            return (
              <button
                key={node.conceptId}
                className={classes.join(" ")}
                style={{ left: nodeX(node.depth), top: nodeY(node.row), width: NODE_WIDTH }}
                title={nameOf(concept)}
                aria-pressed={node.conceptId === selected}
                aria-label={`${nameOf(concept)}：${isCurrent ? "現在地・" : ""}${statusLabel[concept.status]}`}
                onClick={() => onSelect(node.conceptId)}
              >
                <span className="node-name">
                  {concept.status === "confirmed" && <span aria-hidden="true">✓ </span>}
                  {nameOf(concept)}
                </span>
                <span className="node-status">
                  {isCurrent && <em className="badge">現在地</em>}
                  {statusLabel[concept.status]}
                  {concept.manual && <em className="manual">手動</em>}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/** Concept の一覧（前提・次の Concept）。押すとその Concept を選ぶ。 */
function ConceptLinksList({
  ids,
  concepts,
  empty,
  onSelect,
}: {
  ids: readonly string[];
  concepts: ReadonlyMap<string, OverlaidConcept>;
  empty: string;
  onSelect: (conceptId: string) => void;
}) {
  if (ids.length === 0) return <p className="muted">{empty}</p>;
  return (
    <ul className="links">
      {ids.map((id) => {
        const concept = concepts.get(id);
        return (
          <li key={id}>
            <button className="link" onClick={() => onSelect(id)}>
              {concept ? nameOf(concept) : id}
            </button>
            {concept && (
              <span className={`status ${concept.status}`}>{statusLabel[concept.status]}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** 選んだ Concept の詳細。Evidence・前提・次の Concept・理解度の修正をまとめる。 */
function ConceptDetail({
  concept,
  links,
  concepts,
  isCurrent,
  pending,
  onChange,
  onSelect,
  panel,
}: {
  concept: OverlaidConcept;
  links: ConceptLinks | undefined;
  concepts: ReadonlyMap<string, OverlaidConcept>;
  isCurrent: boolean;
  pending: boolean;
  onChange: (status: MasteryStatus | null) => void;
  onSelect: (conceptId: string) => void;
  panel: RefObject<HTMLElement | null>;
}) {
  return (
    <aside className="detail" aria-label="Concept の詳細" ref={panel}>
      <h2>{nameOf(concept)}</h2>
      <p className="detail-status">
        {isCurrent && <em className="badge">現在地</em>}
        <span className={`status ${concept.status}`}>{statusLabel[concept.status]}</span>
        {concept.manual && <em className="manual">手動</em>}
      </p>
      <dl>
        <dt>理解度</dt>
        <dd>{percent(concept.score)}</dd>
        <dt>自力解決</dt>
        <dd>{concept.evidence.solvedIndependentlyCount} 回</dd>
        <dt>ヒント利用</dt>
        <dd>{concept.evidence.hintUsedCount} 回</dd>
        <dt>手動修正</dt>
        <dd>
          {concept.manual
            ? `あり（自動算出では ${statusLabel[concept.derived.status]}・${percent(
                concept.derived.status === "unobserved" ? null : concept.derived.score,
              )}）`
            : "なし"}
        </dd>
      </dl>
      {concept.status === "unobserved" && !concept.manual && (
        <p className="muted">まだ判断材料がありません。0% という意味ではありません。</p>
      )}
      <h3>前提 Concept</h3>
      <ConceptLinksList
        ids={links?.prerequisites ?? []}
        concepts={concepts}
        empty="前提はありません"
        onSelect={onSelect}
      />
      <h3>次に接続する Concept</h3>
      <ConceptLinksList
        ids={links?.next ?? []}
        concepts={concepts}
        empty="この先に続く Concept はありません"
        onSelect={onSelect}
      />
      <MasteryPicker concept={concept} pending={pending} onChange={onChange} />
    </aside>
  );
}

function LearningMap() {
  const { profile, overrides } = Route.useLoaderData();
  const router = useRouter();
  const [saveError, setSaveError] = useState<string>();
  const [pending, setPending] = useState<readonly string[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const detail = useRef<HTMLElement>(null);
  const submitGuard = useRef(createSubmitGuard());
  const overrideQueue = useRef(createOperationQueue());

  const changeStatus = (conceptId: string, status: MasteryStatus | null) => {
    // 入口で弾く（.agents/rules/rules.md RULE-007）。ここを通さずに setPending すると、
    // 同じ Concept が二重に積まれ、弾かれた側の finally が両方を消すため、
    // 最初の保存がまだ終わっていないのに入力が有効へ戻る。
    if (submitGuard.current.isRunning(conceptId)) return;
    setSaveError(undefined);
    setPending((current) => [...current, conceptId]);
    void submitGuard.current
      .run(conceptId, async () => {
        try {
          await overrideQueue.current.run(() =>
            putJson<MasteryOverrides>(OVERRIDES_PATH, { conceptId, status }),
          );
          // 保存できたら loader を捨てて取り直す。応答をそのまま state へ入れると、
          // 以後の再読み込みが表示へ届かなくなる（保存した値が固定されてしまう）。
          // 取り直しの間も画面は残るので、表示が空に戻ることはない。
          await router.invalidate();
        } catch (value: unknown) {
          // 保存の失敗を黙って飲み込まない（RULE-004）。
          // 読み込みエラーとは別に出し、表示は自動算出のまま保つ。
          if (value instanceof ApiError && value.kind === "session_expired") {
            window.location.href = "/login";
            return;
          }
          setSaveError(toErrorText(value));
        }
      })
      .finally(() => {
        setPending((current) => current.filter((id) => id !== conceptId));
      });
  };

  // 応答は観測済みの Concept だけなので、定義の全件と突き合わせて未観測を補う。
  // 手動上書きは補ったあとに重ねる。未観測の Concept も手動で確認済みにできる。
  const conceptList = applyOverrides(completeConcepts(profile.concepts, CONCEPTS), overrides);
  const concepts = new Map(conceptList.map((concept) => [concept.conceptId, concept]));
  const summary = summarizeConcepts(conceptList);
  const current = findCurrentPosition(conceptList);
  const nextIds = current ? (LINKS.get(current)?.next ?? []) : [];
  const next = new Set(nextIds);
  // 何も選んでいなければ現在地を、現在地も無ければ先頭の Concept を開いておく。
  const selected = concepts.get(selectedId ?? current ?? "") ?? conceptList[0];
  // 定義から外れた Concept の観測は地図に載らない。件数だけ数えて見えなくすると
  // 記録が消えたように見えるので、地図の下に並べて選べるようにする（RULE-004）。
  const unmapped = conceptList.filter((concept) => !LINKS.has(concept.conceptId));
  const select = (conceptId: string) => {
    setSelectedId(conceptId);
    // 狭い画面では詳細が地図の下に回るので、選んだことが見えるところまで送る。
    if (window.matchMedia(NARROW_LAYOUT).matches)
      detail.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const currentConcept = current === undefined ? undefined : concepts.get(current);
  return (
    <>
      <section className="summary">
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
      {profile.eventCount === 0 && (
        <p className="hint">
          まだ学習データがありません。学習を始めると、この地図に現在地が現れます。
        </p>
      )}
      <section className="position" aria-label="現在地と次に学ぶ候補">
        {currentConcept ? (
          <>
            <div>
              <span className="muted">現在地</span>
              <button className="link" onClick={() => select(currentConcept.conceptId)}>
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
                    <button className="link" key={id} onClick={() => select(id)}>
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
      <div className="map-layout">
        <div className="map">
          {TREES.map((tree) => (
            <SkillTree
              key={tree.language}
              tree={tree}
              concepts={concepts}
              current={current}
              next={next}
              selected={selected?.conceptId}
              onSelect={select}
            />
          ))}
        </div>
        {selected && (
          <ConceptDetail
            concept={selected}
            links={LINKS.get(selected.conceptId)}
            concepts={concepts}
            isCurrent={selected.conceptId === current}
            pending={pending.includes(selected.conceptId)}
            onChange={(status) => changeStatus(selected.conceptId, status)}
            onSelect={select}
            panel={detail}
          />
        )}
      </div>
      {unmapped.length > 0 && (
        <section className="position unmapped" aria-label="地図に無い Concept">
          <span className="muted">地図に無い Concept</span>
          {unmapped.map((concept) => (
            <button
              className="link"
              key={concept.conceptId}
              onClick={() => select(concept.conceptId)}
            >
              {nameOf(concept)}
            </button>
          ))}
        </section>
      )}
      <footer>
        {profile.eventCount} 件のイベントから導出 ·{" "}
        {new Date(profile.derivedAt).toLocaleString("ja-JP")}
      </footer>
    </>
  );
}

export const Route = createFileRoute("/_framed/")({
  // 習熟度と手動上書きは別の要求だが、loader が1つの結果にまとめるので、
  // 片方だけ古い組み合わせが表示されることがない（RULE-005）。
  loader: async () => {
    const retry = takeLoginRetry();
    const [profile, overrides] = await Promise.all([
      requestJson<Profile>("/api/v1/learning-profile", fetch, retry),
      requestJson<MasteryOverrides>(OVERRIDES_PATH, fetch, retry),
    ]);
    return { profile, overrides };
  },
  component: LearningMap,
});
