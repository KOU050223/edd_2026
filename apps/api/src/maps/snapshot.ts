/**
 * 共有の版の中身（Issue #244 の決定 T2）。
 *
 * 持ち主の手元のマップを「共有へ上げる」と、その時点の中身をこの形の JSON にして
 * learning_map_versions（migrations/0019）に残す。HTTP も D1 も知らない。
 *
 * - 固定の Concept への参照は ID だけを持ち、表示するときに今の固定の一覧から引く。
 * - 持ち主の別のマップのノードへの参照は、持ち主以外から元のマップが見えないので、
 *   上げた時点の表示名・概要・項目を写して持つ（取り込みでは自分のノードとして写す、T3）。
 * - 作成時の確認問題（#247）は、共有に含めると選んだときだけ持つ（S1-a）。
 */

import * as v from "valibot";
import { CHECK_LEVELS, type PersonalConceptCheck } from "@gakushu-sochi/domain";
import { promptSha256 } from "../checks/cache.js";
import type {
  LearningMapDiff,
  LearningMapEdge,
  LearningMapNodeView,
  LearningObjectiveView,
  MapNodeChange,
  MapNodeChangeField,
  MapVersionSummary,
  ReferencedConcept,
  SharedMapContentView,
} from "../contract/learning-maps.js";
import type {
  StoredLearningMap,
  StoredLearningObjective,
  StoredMapContent,
} from "../repository/types.js";

export interface SnapshotOrigin {
  label: string;
  summary?: string;
  objectives: LearningObjectiveView[];
}

export type SnapshotNode =
  | {
      kind: "own";
      conceptId: string;
      label: string;
      summary: string;
      objectives: LearningObjectiveView[];
    }
  | {
      kind: "reference";
      conceptId: string;
      /**
       * 持ち主の別のマップのノードを指すなら、上げた時点の中身。
       * 固定の Concept を指す（表示のときに今の一覧から引く）か、上げた時点で元が
       * 見つからなかったなら `null`。
       */
      origin: SnapshotOrigin | null;
    };

export interface MapSnapshot {
  title: string;
  description: string;
  nodes: SnapshotNode[];
  edges: LearningMapEdge[];
  checks: PersonalConceptCheck[];
}

/**
 * 手元のマップから版の中身を作る。
 *
 * @param references 参照のノードの元（ルートの `resolveReferences` が引いたもの）。
 * @param checks 共有に含める作成時の確認問題。このマップの参照ではないノードのものだけを残す。
 */
export function buildSnapshot(
  map: StoredLearningMap,
  references: ReadonlyMap<string, ReferencedConcept>,
  checks: readonly PersonalConceptCheck[],
): MapSnapshot {
  const ownIds = new Set(
    map.nodes.filter((node) => node.kind === "own").map((node) => node.conceptId),
  );
  return {
    title: map.title,
    description: map.description,
    nodes: map.nodes.map((node): SnapshotNode => {
      if (node.kind === "own") {
        return {
          kind: "own",
          conceptId: node.conceptId,
          label: node.label,
          summary: node.summary,
          objectives: (map.objectives.get(node.conceptId) ?? []).map(toObjectiveView),
        };
      }
      const origin = references.get(node.conceptId);
      // 固定の Concept（mapId が null）は ID だけを持つ。表示のときに今の一覧から引く。
      if (origin === undefined || origin.mapId === null) {
        return { kind: "reference", conceptId: node.conceptId, origin: null };
      }
      return {
        kind: "reference",
        conceptId: node.conceptId,
        origin: {
          label: origin.label,
          ...(origin.summary === undefined ? {} : { summary: origin.summary }),
          objectives: origin.objectives.map(toObjectiveView),
        },
      };
    }),
    edges: map.edges.map((edge) => ({ from: edge.from, to: edge.to })),
    checks: checks
      .filter((check) => ownIds.has(check.conceptId))
      .map((check) => structuredClone(check)),
  };
}

function toObjectiveView(objective: LearningObjectiveView): LearningObjectiveView {
  return { id: objective.id, label: objective.label, source: objective.source };
}

/** 版の中身の JSON。キーの順は {@link buildSnapshot} が作った順で決まり、ハッシュもこれから取る。 */
export function serializeSnapshot(snapshot: MapSnapshot): string {
  return JSON.stringify(snapshot);
}

/** 確認画面で見せた中身と、上げる中身が同じかを確かめるためのハッシュ。 */
export function snapshotHash(snapshot: MapSnapshot): Promise<string> {
  return promptSha256(serializeSnapshot(snapshot));
}

const objectiveSchema = v.strictObject({
  id: v.string(),
  label: v.string(),
  source: v.picklist(["manual", "ai"]),
});

const questionSchema = v.strictObject({
  prompt: v.string(),
  choices: v.array(v.string()),
  answerIndex: v.number(),
  explanation: v.string(),
});

const snapshotSchema = v.strictObject({
  title: v.string(),
  description: v.string(),
  nodes: v.array(
    v.variant("kind", [
      v.strictObject({
        kind: v.literal("own"),
        conceptId: v.string(),
        label: v.string(),
        summary: v.string(),
        objectives: v.array(objectiveSchema),
      }),
      v.strictObject({
        kind: v.literal("reference"),
        conceptId: v.string(),
        origin: v.nullable(
          v.strictObject({
            label: v.string(),
            summary: v.optional(v.string()),
            objectives: v.array(objectiveSchema),
          }),
        ),
      }),
    ]),
  ),
  edges: v.array(v.strictObject({ from: v.string(), to: v.string() })),
  checks: v.array(
    v.strictObject({
      conceptId: v.string(),
      overview: questionSchema,
      practice: v.strictObject({ ...questionSchema.entries, code: v.string() }),
      scope: v.picklist(["concept", "objective"]),
      objectiveId: v.optional(v.string()),
      level: v.picklist(CHECK_LEVELS),
      model: v.string(),
      generatedAt: v.string(),
    }),
  ),
});

/**
 * 保存した版の中身を読む。こちらが書いた JSON なので、形が違えば壊れている（RULE-004）。
 * 黙って空のマップとして扱わず、例外にする。
 */
export function parseSnapshot(json: string, label: string): MapSnapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new Error(`learning_map_versions.content is not JSON: ${label}`, { cause: error });
  }
  const parsed = v.safeParse(snapshotSchema, raw);
  if (!parsed.success) {
    throw new Error(`learning_map_versions.content has an unexpected shape: ${label}`);
  }
  return parsed.output;
}

/**
 * 表示する形へ変える。固定の Concept への参照は `resolveFixed` で今の一覧から引く。
 * 参照の `origin.mapId` は、持ち主以外から元のマップが見えないので `null` にする。
 */
export function snapshotContentView(
  snapshot: MapSnapshot,
  resolveFixed: (conceptId: string) => ReferencedConcept | undefined,
): SharedMapContentView {
  return {
    title: snapshot.title,
    description: snapshot.description,
    nodes: snapshot.nodes.map((node): LearningMapNodeView => {
      if (node.kind === "own") return structuredClone(node);
      const origin: ReferencedConcept | null =
        node.origin === null
          ? (resolveFixed(node.conceptId) ?? null)
          : { ...structuredClone(node.origin), mapId: null };
      return { kind: "reference", conceptId: node.conceptId, origin };
    }),
    edges: structuredClone(snapshot.edges),
    checks: structuredClone(snapshot.checks),
  };
}

/**
 * 版の中身を、持ち主の手元のマップへ書き戻す形にする（復元、T2）。
 * 参照のノードは参照のまま戻す（写した中身は手元では使わない。元は持ち主の別のマップにある）。
 */
export function snapshotToStoredContent(snapshot: MapSnapshot): {
  content: StoredMapContent;
  objectives: StoredLearningObjective[];
} {
  return {
    content: {
      title: snapshot.title,
      description: snapshot.description,
      nodes: snapshot.nodes.map((node) =>
        node.kind === "own"
          ? { kind: "own", conceptId: node.conceptId, label: node.label, summary: node.summary }
          : { kind: "reference", conceptId: node.conceptId },
      ),
      edges: structuredClone(snapshot.edges),
    },
    objectives: snapshot.nodes.flatMap((node) =>
      node.kind === "own"
        ? node.objectives.map((objective) => ({ ...objective, conceptId: node.conceptId }))
        : [],
    ),
  };
}

/** ノードの前提（1つまで）。線は「前提 → 次」。 */
function prerequisitesOf(edges: readonly LearningMapEdge[]): Map<string, string> {
  return new Map(edges.map((edge) => [edge.to, edge.from]));
}

/** 表示名・概要・項目は、参照なら元のものを比べる。 */
function shown(node: LearningMapNodeView): {
  label: string | null;
  summary: string | null;
  objectives: LearningObjectiveView[];
} {
  if (node.kind === "own") return node;
  return {
    label: node.origin?.label ?? null,
    summary: node.origin?.summary ?? null,
    objectives: node.origin?.objectives ?? [],
  };
}

function sameObjectives(a: readonly LearningObjectiveView[], b: readonly LearningObjectiveView[]) {
  return (
    a.length === b.length &&
    a.every((objective, index) => {
      const other = b[index];
      return other !== undefined && objective.id === other.id && objective.label === other.label;
    })
  );
}

function checkKey(check: PersonalConceptCheck): string {
  return `${check.conceptId}\n${check.objectiveId ?? "concept"}`;
}

/**
 * キーの順に依らない JSON。保存した版を読んだ組（スキーマの順）と、D1 から読んだ組
 * （列から組み立てた順）はキーの順が違うので、そのまま文字列にすると同じ組が違って見える
 * （PR #294 のレビュー）。配列の順は保つ。
 */
function canonicalJson(value: unknown): string {
  const canonical = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(canonical)
      : item !== null && typeof item === "object"
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, canonical((item as Record<string, unknown>)[key])]),
          )
        : item;
  return JSON.stringify(canonical(value));
}

/**
 * 2つの中身の差分。`before` が `null` なら（まだ版が無い）、すべて「足した」になる。
 * ノードは Concept ID で突き合わせる。
 */
export function diffContents(
  before: SharedMapContentView | null,
  after: SharedMapContentView,
): LearningMapDiff {
  const beforeNodes = new Map((before?.nodes ?? []).map((node) => [node.conceptId, node]));
  const afterIds = new Set(after.nodes.map((node) => node.conceptId));
  const beforePrerequisites = prerequisitesOf(before?.edges ?? []);
  const afterPrerequisites = prerequisitesOf(after.edges);

  const added: LearningMapNodeView[] = [];
  const changed: MapNodeChange[] = [];
  for (const node of after.nodes) {
    const old = beforeNodes.get(node.conceptId);
    if (old === undefined) {
      added.push(node);
      continue;
    }
    const fields: MapNodeChangeField[] = [];
    const a = shown(old);
    const b = shown(node);
    if (old.kind !== node.kind) fields.push("kind");
    if (a.label !== b.label) fields.push("label");
    if (a.summary !== b.summary) fields.push("summary");
    const prerequisiteBefore = beforePrerequisites.get(node.conceptId) ?? null;
    const prerequisiteAfter = afterPrerequisites.get(node.conceptId) ?? null;
    if (prerequisiteBefore !== prerequisiteAfter) fields.push("prerequisite");
    if (!sameObjectives(a.objectives, b.objectives)) fields.push("objectives");
    if (fields.length > 0) {
      changed.push({
        conceptId: node.conceptId,
        fields,
        before: old,
        after: node,
        prerequisiteBefore,
        prerequisiteAfter,
      });
    }
  }
  const removed = (before?.nodes ?? []).filter((node) => !afterIds.has(node.conceptId));
  // 両方にあるノードだけで並びを比べる（足した・消したノードで位置がずれた分は数えない）。
  const kept = (nodes: readonly LearningMapNodeView[], other: ReadonlySet<string>) =>
    nodes.map((node) => node.conceptId).filter((conceptId) => other.has(conceptId));
  const beforeOrder = kept(before?.nodes ?? [], afterIds);
  const afterOrder = kept(after.nodes, new Set(beforeNodes.keys()));
  const reordered = beforeOrder.some((conceptId, index) => afterOrder[index] !== conceptId);

  const beforeChecks = new Map((before?.checks ?? []).map((check) => [checkKey(check), check]));
  const afterChecks = new Map(after.checks.map((check) => [checkKey(check), check]));
  const sameCheck = (a: PersonalConceptCheck, b: PersonalConceptCheck) =>
    canonicalJson(a) === canonicalJson(b);
  const checksAdded = after.checks.filter((check) => {
    const old = beforeChecks.get(checkKey(check));
    return old === undefined || !sameCheck(old, check);
  });
  const checksRemoved = (before?.checks ?? []).filter((check) => {
    const next = afterChecks.get(checkKey(check));
    return next === undefined || !sameCheck(next, check);
  });

  return {
    title:
      before !== null && before.title === after.title
        ? null
        : { before: before?.title ?? "", after: after.title },
    description:
      before !== null && before.description === after.description
        ? null
        : { before: before?.description ?? "", after: after.description },
    added,
    removed,
    changed,
    reordered,
    checks: { added: checksAdded, removed: checksRemoved },
  };
}

/** 差分が空か（上げても新しい版にならない）。 */
export function isEmptyDiff(diff: LearningMapDiff): boolean {
  return (
    diff.title === null &&
    diff.description === null &&
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.changed.length === 0 &&
    !diff.reordered &&
    diff.checks.added.length === 0 &&
    diff.checks.removed.length === 0
  );
}

export function summarizeDiff(diff: LearningMapDiff): MapVersionSummary {
  return {
    added: diff.added.length,
    removed: diff.removed.length,
    changed: diff.changed.length,
    titleChanged: diff.title !== null,
    reordered: diff.reordered,
    checksAdded: diff.checks.added.length,
    checksRemoved: diff.checks.removed.length,
  };
}
