/**
 * 共有マップの取り込みと取り込み直し（Issue #244 の決定 T3・T4）。HTTP も D1 も知らない。
 *
 * - 取り込み: 共有の側の版の中身を、取り込んだ人の新しいマップ（個人マップ）の形へ写す。
 *   ノードと「理解すること」は元の ID のまま。固定の Concept への参照は参照のまま。
 *   持ち主の別のマップを指す参照は、取り込んだ人からは元が見えないので、版に写した中身で
 *   自分のノードにする。
 * - 取り込み直し: 共有の側にあるノードは新しい版の中身で上書きし、個人マップで足したノードは残す。
 *   共有の側で消されたノードは、選んだものだけ残す（既定は消す）。
 */

import type { MapSourceView } from "../contract/learning-maps.js";
import type {
  StoredLearningMap,
  StoredLearningObjective,
  StoredMapContent,
  StoredMapNode,
  StoredMapSource,
} from "../repository/types.js";
import type { MapSnapshot } from "./snapshot.js";

/** 取り込み元を一覧・表示の形にする（鍵とノードの一覧は出さない）。 */
export function toMapSourceView(source: StoredMapSource | null): MapSourceView | null {
  if (source === null) return null;
  return {
    mapId: source.mapId,
    title: source.title,
    version: source.version,
    latestVersion: source.latest?.version ?? null,
  };
}

export interface ImportedContent {
  content: StoredMapContent;
  objectives: StoredLearningObjective[];
  /** 版のノードの Concept ID（取り込み直しで、共有の側で消されたノードを見分ける）。 */
  nodeIds: string[];
}

/** 版の中身を、個人マップに入れる形へ写す（T3）。 */
export function importSnapshot(snapshot: MapSnapshot): ImportedContent {
  const nodes: StoredMapNode[] = [];
  const objectives: StoredLearningObjective[] = [];
  for (const node of snapshot.nodes) {
    if (node.kind === "reference" && node.origin === null) {
      // 固定の Concept（または上げた時点で元が見つからなかった参照）は参照のまま。
      nodes.push({ kind: "reference", conceptId: node.conceptId });
      continue;
    }
    const shown = node.kind === "own" ? node : node.origin;
    // 写した元は手作りのノードなので、概要は必ずある（概要は必須）。無ければ版が壊れている。
    // 空の概要で入れると、個人マップを直して保存するときに検証で弾かれる。
    if (shown === null || shown.summary === undefined) {
      throw new Error(`snapshot node has no summary: ${node.conceptId}`);
    }
    nodes.push({
      kind: "own",
      conceptId: node.conceptId,
      label: shown.label,
      summary: shown.summary,
    });
    objectives.push(
      ...shown.objectives.map((objective) => ({
        id: objective.id,
        conceptId: node.conceptId,
        label: objective.label,
        source: objective.source,
      })),
    );
  }
  return {
    content: {
      title: snapshot.title,
      description: snapshot.description,
      nodes,
      edges: snapshot.edges.map((edge) => ({ from: edge.from, to: edge.to })),
    },
    objectives,
    nodeIds: snapshot.nodes.map((node) => node.conceptId),
  };
}

/** 個人マップのノードのうち、共有の側で消されたもの（取り込んだ版にあり、新しい版に無い）。 */
export function removedFromSource(
  personal: StoredLearningMap,
  source: StoredMapSource,
  latest: MapSnapshot,
): StoredMapNode[] {
  const imported = new Set(source.nodeIds);
  const latestIds = new Set(latest.nodes.map((node) => node.conceptId));
  return personal.nodes.filter(
    (node) => imported.has(node.conceptId) && !latestIds.has(node.conceptId),
  );
}

/**
 * 取り込み直したあとの個人マップ（T4）。
 *
 * - 新しい版のノードを、版の並びで先に置く（共有の側の中身で上書きする）。
 * - 個人マップで足したノード（取り込んだ版に無かったもの）と、共有の側で消されたが `keep` に
 *   入れたノードを、個人マップの並びのまま後ろに置く（自分のノードとして持ち続ける）。
 * - 線は新しい版のものに、後ろに置いたノードへ入る線（前提が残るものだけ）を足す。
 *   前提は1つのノードにつき1つまで（#242）なので、共有の側のノードの前提は共有の側に合わせる。
 *
 * `keep` に、共有の側で消されたノード以外の ID が入っていても無視する。
 */
export function planReimport(
  personal: StoredLearningMap,
  source: StoredMapSource,
  latest: MapSnapshot,
  keep: ReadonlySet<string>,
): ImportedContent {
  const next = importSnapshot(latest);
  const latestIds = new Set(next.nodeIds);
  const imported = new Set(source.nodeIds);
  const kept = personal.nodes.filter(
    (node) =>
      !latestIds.has(node.conceptId) && (!imported.has(node.conceptId) || keep.has(node.conceptId)),
  );
  const keptIds = new Set(kept.map((node) => node.conceptId));
  const finalIds = new Set([...latestIds, ...keptIds]);
  return {
    content: {
      title: next.content.title,
      description: next.content.description,
      nodes: [...next.content.nodes, ...kept],
      edges: [
        ...next.content.edges,
        ...personal.edges.filter((edge) => keptIds.has(edge.to) && finalIds.has(edge.from)),
      ],
    },
    objectives: [
      ...next.objectives,
      ...kept.flatMap((node) =>
        node.kind === "own" ? (personal.objectives.get(node.conceptId) ?? []) : [],
      ),
    ],
    nodeIds: next.nodeIds,
  };
}
