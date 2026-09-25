/**
 * Learning Map（Skill Tree + 現在地）の描画に使うロジック。
 *
 * React の描画から切り離しておき、単体テストで検証できるようにする（apps/web/AGENTS.md）。
 */

import type { Concept as ConceptDefinition } from "@gakushu-sochi/domain";
import type { OverlaidConcept } from "./overrides.js";
import { summarizeConcepts, type Concept, type Familiarity } from "./profile.js";

/**
 * API が返した観測済みの Concept へ、未観測の Concept を補って全件にする。
 *
 * `GET /v1/learning-profile` は観測のある Concept しか返さない（未観測を 0 で埋めない契約）。
 * 地図は全 Concept を最初から見せたいので、定義に在って応答に無いものをここで
 * `unobserved` として足す。並びは定義順（学習の推奨順）に揃える。
 *
 * 定義に無い ID の観測は捨てずに末尾へ残す。黙って消すと、定義から外した Concept の
 * 学習記録が画面から見えなくなる（RULE-004）。
 */
export function completeConcepts(
  observed: readonly Concept[],
  definitions: readonly ConceptDefinition[],
): Concept[] {
  const byId = new Map(observed.map((concept) => [concept.conceptId, concept]));
  const known = new Set(definitions.map((definition) => definition.id));
  const completed = definitions.map(
    (definition): Concept =>
      byId.get(definition.id) ?? {
        conceptId: definition.id,
        label: definition.label,
        status: "unobserved",
        score: 0,
        evidence: { solvedIndependentlyCount: 0, hintUsedCount: 0 },
      },
  );
  return [...completed, ...observed.filter((concept) => !known.has(concept.conceptId))];
}

/**
 * Familiarity の一覧を Concept ID で引ける表へする（Issue #157）。
 *
 * 「なぜこの状態か」の出典表示と、履歴の形跡がある Concept の判別に使う。
 * `label` は API が付けるが、無いときは呼び出し側で ID を見せる。
 */
export function familiarityByConcept(
  list: readonly Familiarity[] | undefined,
): ReadonlyMap<string, Familiarity> {
  return new Map((list ?? []).map((entry) => [entry.conceptId, entry]));
}

/**
 * Concept の一覧へ Familiarity を結ぶ。Mastery の値（status/score）は変えず、
 * `familiarity` フィールドとして載せるだけである（Issue #157）。
 */
export function attachFamiliarity<T extends { conceptId: string }>(
  concepts: readonly T[],
  list: readonly Familiarity[] | undefined,
): (T & { familiarity?: Familiarity })[] {
  const byId = familiarityByConcept(list);
  return concepts.map((concept) => {
    const entry = byId.get(concept.conceptId);
    return entry === undefined ? concept : { ...concept, familiarity: entry };
  });
}

const SOURCE_LABELS: Record<string, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  vscode: "VS Code",
  chatgpt: "ChatGPT",
  claude: "Claude",
  copilot: "GitHub Copilot",
  cursor: "Cursor",
  gemini: "Gemini",
};

/** 履歴ソースの表示名。未知のソースは ID をそのまま見せる。 */
export function historySourceLabel(provider: string): string {
  return SOURCE_LABELS[provider] ?? provider;
}

/**
 * 「なぜこの状態か」の説明文。例: 「Codex で7件・最後に触れたのは 2024-01-02」。
 *
 * 日付はロケール表示せず ISO の日付部分だけにする。導出値（何日前か）は
 * 「今」を依存に持ち込むため、ここでは生の日付を出す。
 */
export function describeFamiliarity(familiarity: Familiarity): string {
  const sources = familiarity.sources
    .map((source) => `${historySourceLabel(source.provider)} ${source.count}件`)
    .join("・");
  const last =
    familiarity.lastObservedAt === undefined
      ? undefined
      : `最後に触れたのは ${familiarity.lastObservedAt.slice(0, 10)}`;
  return [sources, last].filter(Boolean).join("、");
}

/**
 * 現在地にする Concept を選ぶ。学習中のうち、最後に観測したものが現在地である。
 *
 * 観測時刻の無い学習中（手動で学習中にしたもの）や時刻が読めないものは、
 * 観測のあるものより後ろに回す。
 * 同じ時刻なら先に並ぶ（定義順で手前の）ものを選ぶ。学習中が無ければ現在地は無い。
 */
export function findCurrentPosition(concepts: readonly OverlaidConcept[]): string | undefined {
  let current: OverlaidConcept | undefined;
  for (const concept of concepts) {
    if (concept.status !== "learning") continue;
    if (!current || observedAt(concept) > observedAt(current)) current = concept;
  }
  return current?.conceptId;
}

/**
 * 観測時刻をミリ秒へ直す。無い・読めない時刻は最も古い扱いにする。
 *
 * 読めない時刻を `NaN` のまま比べると、比較が常に偽になり、先に並んだ Concept が
 * どれほど古くても現在地に居座る。
 */
function observedAt(concept: OverlaidConcept): number {
  const value = concept.evidence.lastObservedAt;
  const time = value === undefined ? Number.NaN : Date.parse(value);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

/** Concept ごとの前提と、その Concept を前提に持つ Concept（次に接続する Concept）。 */
export interface ConceptLinks {
  prerequisites: readonly string[];
  next: readonly string[];
}

/**
 * 定義の `prerequisites` から、双方向の接続を引けるようにする。
 *
 * 定義に無い ID への前提は辺にしない（地図上に端点が無い）。
 * packages/domain の生成スクリプトが未定義の前提を拒むので、通常は起きない。
 */
export function linkConcepts(
  definitions: readonly ConceptDefinition[],
): ReadonlyMap<string, ConceptLinks> {
  const known = new Set(definitions.map((definition) => definition.id));
  const links = new Map<string, { prerequisites: string[]; next: string[] }>(
    definitions.map((definition) => [definition.id, { prerequisites: [], next: [] }]),
  );
  for (const definition of definitions) {
    for (const prerequisite of definition.prerequisites ?? []) {
      if (!known.has(prerequisite)) continue;
      links.get(definition.id)?.prerequisites.push(prerequisite);
      links.get(prerequisite)?.next.push(definition.id);
    }
  }
  return links;
}

/**
 * Concept ID から、地図の中で属する領域（木の `language`）を引く。
 *
 * 別領域の Concept への遷移先を決めるための逆引き表。
 * 地図に無い Concept（定義から外れた観測）は表に入らない。
 */
export function conceptAreas(trees: readonly MapTree[]): ReadonlyMap<string, string> {
  return new Map(
    trees.flatMap((tree) => tree.nodes.map((node) => [node.conceptId, tree.language] as const)),
  );
}

/**
 * 1 領域ぶんの集計。項目カードとマップ画面の見出しに使う。
 *
 * 木に載っている Concept だけを数える。地図に無い Concept はどの領域にも
 * 属さないので、領域の合計を全件の合計と混ぜない。
 */
export function summarizeTree(
  tree: MapTree,
  concepts: ReadonlyMap<string, OverlaidConcept>,
): {
  confirmed: number;
  learning: number;
  unobserved: number;
  total: number;
  /**
   * この領域の Concept が全件 確認済みか（コンプリート）。
   *
   * 表示のための導出であって、達成の記録そのものではない。記録は
   * `POST /v1/area-completions:check` がサーバー側で持つ。Concept があとから
   * 増えると、記録は残ったままこの値だけが false に戻る。
   */
  complete: boolean;
} {
  const inTree = tree.nodes.flatMap((node) => {
    const concept = concepts.get(node.conceptId);
    return concept === undefined ? [] : [concept];
  });
  const summary = summarizeConcepts(inTree);
  return {
    ...summary,
    total: inTree.length,
    complete: inTree.length > 0 && summary.confirmed === inTree.length,
  };
}

export interface MapNode {
  conceptId: string;
  /** 根からの段数。前提の最も長い経路で決める。 */
  depth: number;
  /** 段の中での縦位置。子の中央へ親を置くので小数になりうる。 */
  row: number;
}

export interface MapEdge {
  from: string;
  to: string;
}

/** プレフィックスごとの 1 枚の木。 */
export interface MapTree {
  language: string;
  nodes: MapNode[];
  edges: MapEdge[];
  /** 段数（列の数）。 */
  depths: number;
  /** 行数。 */
  rows: number;
}

/**
 * Concept 定義を、プレフィックスごとの Skill Tree の配置へ変換する。
 *
 * 列は前提を辿った最長の段数、行は木を深さ優先で辿った葉の順で決める。
 * 複数の前提を持つ Concept は、最も深い前提（同じ深さなら先に書かれた前提）の子として
 * 置く。残りの前提も辺としては描く。
 *
 * 前提が循環していたら例外を投げる。生成スクリプトが循環を拒むので本来は起きないが、
 * 起きたときに黙って欠けた地図を出すと、壊れていることに誰も気づけない（RULE-004）。
 */
export function layoutTrees(definitions: readonly ConceptDefinition[]): MapTree[] {
  const languages = [...new Set(definitions.map((definition) => definition.language))];
  return languages.map((language) =>
    layoutTree(
      language,
      definitions.filter((definition) => definition.language === language),
    ),
  );
}

function layoutTree(language: string, definitions: readonly ConceptDefinition[]): MapTree {
  const links = linkConcepts(definitions);
  const depthOf = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    const known = depthOf.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) throw new Error(`Concept の前提が循環している: ${id}`);
    visiting.add(id);
    const prerequisites = links.get(id)?.prerequisites ?? [];
    const value = prerequisites.length === 0 ? 0 : 1 + Math.max(...prerequisites.map(depth));
    visiting.delete(id);
    depthOf.set(id, value);
    return value;
  };
  for (const definition of definitions) depth(definition.id);

  // 配置上の親：最も深い前提。子は定義順に並べる。
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const definition of definitions) {
    const prerequisites = links.get(definition.id)?.prerequisites ?? [];
    const parent = prerequisites.reduce<string | undefined>(
      (best, id) => (best === undefined || depth(id) > depth(best) ? id : best),
      undefined,
    );
    if (parent === undefined) roots.push(definition.id);
    else children.set(parent, [...(children.get(parent) ?? []), definition.id]);
  }

  const rowOf = new Map<string, number>();
  let nextRow = 0;
  const place = (id: string): number => {
    const kids = children.get(id) ?? [];
    const rows = kids.map(place);
    const first = rows[0];
    const last = rows[rows.length - 1];
    const row = first === undefined || last === undefined ? nextRow++ : (first + last) / 2;
    rowOf.set(id, row);
    return row;
  };
  roots.forEach(place);

  const nodes = definitions.map((definition) => {
    const row = rowOf.get(definition.id);
    if (row === undefined) throw new Error(`Concept を地図に配置できない: ${definition.id}`);
    return { conceptId: definition.id, depth: depth(definition.id), row };
  });
  const edges = definitions.flatMap((definition) =>
    (links.get(definition.id)?.prerequisites ?? []).map((from) => ({ from, to: definition.id })),
  );
  return {
    language,
    nodes,
    edges,
    depths: Math.max(0, ...nodes.map((node) => node.depth)) + 1,
    rows: nextRow,
  };
}
