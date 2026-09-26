/**
 * Learning Map の画面部品と、両ルート（項目一覧 `/`・領域別マップ `/map/$language`）で
 * 共有するロジック。描画に依存しない判断は `learning-map.ts` 側へ寄せる。
 */

import { CONCEPTS } from "@gakushu-sochi/domain";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState, type RefObject } from "react";
import {
  ApiError,
  createOperationQueue,
  createSubmitGuard,
  postJson,
  putJson,
  requestJson,
} from "./api.js";
import { toErrorText } from "./errors.js";
import {
  attachFamiliarity,
  completeConcepts,
  conceptAreas,
  describeFamiliarity,
  layoutTrees,
  linkConcepts,
  type ConceptLinks,
  type MapTree,
} from "./learning-map.js";
import {
  applyOverrides,
  MASTERY_STATUSES,
  type MasteryOverrides,
  type MasteryStatus,
  type OverlaidConcept,
} from "./overrides.js";
import type { Concept, Familiarity } from "./profile.js";
import { takeLoginRetry } from "./session.js";

export type MapProfile = {
  derivedAt: string;
  eventCount: number;
  concepts: Concept[];
  /** 外部履歴由来の「触れた形跡」（Issue #157）。古い API は返さないので省略可。 */
  familiarity?: Familiarity[];
};

const OVERRIDES_PATH = "/api/v1/mastery-overrides";
const COMPLETIONS_PATH = "/api/v1/area-completions:check";

/** 分野コンプリートの記録。契約は apps/api/src/contract/area-completions.ts。 */
export interface AreaCompletion {
  language: string;
  completedAt: string;
}

export interface AreaCompletions {
  version: number;
  completions: AreaCompletion[];
  /** この読み込みで初めて記録された分野。ここに入っているものだけを祝う。 */
  newlyCompleted: string[];
}

// 習熟度と手動上書きは別の要求だが、loader が1つの結果にまとめるので、
// 片方だけ古い組み合わせが表示されることがない（RULE-005）。
// 項目一覧と領域別マップの両方が同じデータを使う。
export async function loadLearningMap(): Promise<{
  profile: MapProfile | null;
  overrides: MasteryOverrides | null;
  /** 達成の記録。未ログイン、または読めなかったときは `undefined`。 */
  completions?: AreaCompletions;
  /** 記録を読めなかった理由。地図は出したうえで画面に出す（RULE-004）。 */
  completionsError?: string;
}> {
  const retry = takeLoginRetry();
  let profile: MapProfile;
  let overrides: MasteryOverrides;
  try {
    [profile, overrides] = await Promise.all([
      requestJson<MapProfile>("/api/v1/learning-profile", fetch, retry),
      requestJson<MasteryOverrides>(OVERRIDES_PATH, fetch, retry),
    ]);
  } catch (error) {
    // 未ログインは失敗ではない（Issue #182）。地図の形は Concept の定義だけで
    // 描けるので、profile 無しのまま画面へ進み、画面側で導線を出す。
    if (error instanceof ApiError && error.kind === "login_required")
      return { profile: null, overrides: null };
    throw error;
  }

  // 分野コンプリートの判定はサーバーが行う（apps/api/src/routes/area-completions.ts）。
  // これは POST なので、同意の記録が無いと Worker が 403 で止める（#174）。
  // 地図そのものは同意が無くても読めるので、記録が取れなくても画面は出す。
  // ただし黙って消さない。理由を持ち帰って画面に出す（RULE-004）。
  let completions: AreaCompletions | undefined;
  let completionsError: string | undefined;
  try {
    completions = await postJson<AreaCompletions>(COMPLETIONS_PATH);
  } catch (error) {
    // セッションが切れているなら地図そのものも出せない。呼び出し元へ通す。
    if (
      error instanceof ApiError &&
      (error.kind === "session_expired" || error.kind === "login_required")
    )
      throw error;
    completionsError = toErrorText(error);
  }
  return { profile, overrides, completions, completionsError };
}

/**
 * コンプリートの印。分野の Concept が全件 確認済みになった分野に付ける。
 *
 * 色だけで伝えない。星の形と「COMPLETE」の文字を必ず並べる。
 */
export function CompleteBadge({ small }: { small?: boolean }) {
  return (
    <span className={`complete-badge${small ? " small" : ""}`}>
      <svg viewBox="0 0 16 16" width={small ? 11 : 13} height={small ? 11 : 13} aria-hidden>
        <path
          d="M8 1.5l1.9 4 4.4.6-3.2 3 .8 4.4L8 11.4 4.1 13.5l.8-4.4-3.2-3 4.4-.6z"
          fill="currentColor"
        />
      </svg>
      COMPLETE
    </span>
  );
}

/** 選択中の Concept を URL に載せる。載せると共有・再読み込みで同じ詳細が開く。 */
export function parseConceptSearch(search: Record<string, unknown>): { concept?: string } {
  return { concept: typeof search.concept === "string" ? search.concept : undefined };
}

// Concept の定義は描画のたびに変わらないので、接続と配置はモジュールの読み込み時に一度だけ作る。
export const LINKS = linkConcepts(CONCEPTS);
export const TREES = layoutTrees(CONCEPTS);
export const AREAS = conceptAreas(TREES);

// 応答は観測済みの Concept だけなので、定義の全件と突き合わせて未観測を補う。
// 手動上書きは補ったあとに重ねる。未観測の Concept も手動で確認済みにできる。
export function overlaidConcepts(
  profile: MapProfile | null,
  overrides: MasteryOverrides | null,
): OverlaidConcept[] {
  // Familiarity は Mastery を底上げしない。「過去に触れた形跡」として
  // 別のフィールドに載せる（Issue #157）。
  return attachFamiliarity(
    applyOverrides(completeConcepts(profile?.concepts ?? [], CONCEPTS), overrides ?? {}),
    profile?.familiarity,
  );
}

export const statusLabel: Record<MasteryStatus, string> = {
  confirmed: "確認済み",
  learning: "学習中",
  unobserved: "未観測",
};

// キーは Concept ID のプレフィックス（言語とは限らない。docs/concepts.md）。
export const languageLabel: Record<string, string> = {
  go: "Go",
  ts: "TypeScript",
  python: "Python",
  rust: "Rust",
  java: "Java",
  csharp: "C#",
  php: "PHP",
  ruby: "Ruby",
  git: "Git",
  design: "設計",
  db: "データベース",
  http: "HTTP",
};

// 地図の寸法（px）。ノードは固定の大きさの箱で、列は前提の段数、行は木の葉の順。
const NODE_WIDTH = 150;
const NODE_HEIGHT = 48;
const COLUMN_GAP = 24;
const ROW_GAP = 12;
const nodeX = (depth: number) => depth * (NODE_WIDTH + COLUMN_GAP);
const nodeY = (row: number) => row * (NODE_HEIGHT + ROW_GAP);

// style.css で詳細パネルを地図の下へ回す幅。値を揃えること。
export const NARROW_LAYOUT = "(max-width: 600px)";

export const nameOf = (concept: OverlaidConcept) => concept.label ?? concept.conceptId;
const percent = (score: number | null) => (score === null ? "—" : `${Math.round(score * 100)}%`);

/**
 * Concept を選ぶ遷移。属する領域があればそのマップへ、
 * 地図に無い Concept は項目一覧へ（どちらも `?concept=` で詳細が開く）。
 */
export function useGoToConcept(): (conceptId: string) => void {
  const navigate = useNavigate();
  return (conceptId) => {
    const language = AREAS.get(conceptId);
    if (language === undefined) {
      void navigate({ to: "/", search: { concept: conceptId } });
    } else {
      void navigate({
        to: "/map/$language",
        params: { language },
        search: { concept: conceptId },
      });
    }
  };
}

/**
 * 理解度の手動修正を保存する。送信中は入口で弾く（RULE-007）。
 * 保存できたら loader を捨てて取り直す。応答をそのまま state へ入れると、
 * 以後の再読み込みが表示へ届かなくなる（保存した値が固定されてしまう）。
 * 取り直しの間も画面は残るので、表示が空に戻ることはない。
 */
export function useMasteryChange(): {
  saveError: string | undefined;
  pending: readonly string[];
  changeStatus: (conceptId: string, status: MasteryStatus | null) => void;
} {
  const router = useRouter();
  const [saveError, setSaveError] = useState<string>();
  const [pending, setPending] = useState<readonly string[]>([]);
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
  return { saveError, pending, changeStatus };
}

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

/** 1 領域ぶんの Skill Tree。Map 内には Concept 名と状態だけを出し、詳細は右のパネルへ回す。 */
export function SkillTree({
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
                  {/* 履歴だけある Concept は「未観測」ではなく
                      「触れた形跡あり」として区別する（Issue #157） */}
                  {concept.status === "unobserved" && concept.familiarity && (
                    <em className="familiar">履歴あり</em>
                  )}
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
export function ConceptDetail({
  concept,
  links,
  concepts,
  isCurrent,
  pending,
  loggedIn,
  onChange,
  onSelect,
  panel,
}: {
  concept: OverlaidConcept;
  links: ConceptLinks | undefined;
  concepts: ReadonlyMap<string, OverlaidConcept>;
  isCurrent: boolean;
  pending: boolean;
  loggedIn: boolean;
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
      {concept.familiarity && (
        <>
          <h3>過去の学習履歴から</h3>
          <p className="muted">
            {describeFamiliarity(concept.familiarity)}
            {concept.familiarity.observationCount > 0 &&
              `（観測 ${concept.familiarity.observationCount} 件）`}
          </p>
          {concept.derived.status === "unobserved" && (
            <p className="muted">
              過去に触れた形跡はありますが、学習の記録では確認されていません。
            </p>
          )}
        </>
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
      {loggedIn && <MasteryPicker concept={concept} pending={pending} onChange={onChange} />}
    </aside>
  );
}
