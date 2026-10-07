/**
 * 学習マップの編集画面（Issue #242、フォーム型）の下書きの操作。
 *
 * 画面は下書きを state に持ち、ここの関数で作り直す。保存のときに API の形
 * （`PUT /v1/learning-maps/:id`）へ変える。描画に依存しないので単体テストできる。
 *
 * 線は持たず、ノードごとの「前提」で持つ。画面は前提をチェックボックスで選ぶので、
 * この形のほうが扱いやすい。保存のときに「前提 → このノード」の線へ直す。
 */

import type { Concept as DomainConcept } from "@gakushu-sochi/domain";
import { MISSING_ORIGIN_LABEL, type LearningMapView } from "./learning-maps.js";

/** API と同じ上限（apps/api/src/contract/learning-maps.ts）。入力欄の `maxLength` にも使う。 */
export const EDITOR_LIMITS = {
  title: 80,
  description: 400,
  nodes: 50,
  label: 40,
  summary: 200,
  objectives: 8,
  objectiveLabel: 80,
} as const;

/**
 * 下書きのノード。
 *
 * `ref` は保存済みのノードなら Concept ID、新しいノードなら `new:<番号>`（API の仮の番号）。
 * 参照のノードは `ref` が元の Concept ID で、表示名・概要は元のものを見せるだけで送らない。
 */
export type DraftNode =
  | { kind: "own"; ref: string; label: string; summary: string; prerequisites: string[] }
  | { kind: "reference"; ref: string; label: string; prerequisites: string[] };

export interface MapDraft {
  title: string;
  description: string;
  nodes: DraftNode[];
}

/** 保存済みのマップから下書きを作る。 */
export function draftFromMap(map: LearningMapView): MapDraft {
  const prerequisites = new Map<string, string[]>();
  for (const edge of map.edges) {
    prerequisites.set(edge.to, [...(prerequisites.get(edge.to) ?? []), edge.from]);
  }
  return {
    title: map.title,
    description: map.description,
    nodes: map.nodes.map((node): DraftNode => {
      const ref = node.conceptId;
      const before = prerequisites.get(ref) ?? [];
      return node.kind === "own"
        ? { kind: "own", ref, label: node.label, summary: node.summary, prerequisites: before }
        : {
            kind: "reference",
            ref,
            label: node.origin?.label ?? MISSING_ORIGIN_LABEL,
            prerequisites: before,
          };
    }),
  };
}

/** まだ使っていない仮の番号（`new:1`, `new:2` …）。 */
export function nextNewRef(draft: MapDraft): string {
  const used = new Set(draft.nodes.map((node) => node.ref));
  let index = 1;
  while (used.has(`new:${String(index)}`)) index++;
  return `new:${String(index)}`;
}

export function addOwnNode(draft: MapDraft): { draft: MapDraft; ref: string } {
  const ref = nextNewRef(draft);
  return {
    draft: {
      ...draft,
      nodes: [...draft.nodes, { kind: "own", ref, label: "", summary: "", prerequisites: [] }],
    },
    ref,
  };
}

/** 既存の Concept を参照で足す。同じ Concept が既にあれば何もしない。 */
export function addReference(draft: MapDraft, conceptId: string, label: string): MapDraft {
  if (draft.nodes.some((node) => node.ref === conceptId)) return draft;
  return {
    ...draft,
    nodes: [...draft.nodes, { kind: "reference", ref: conceptId, label, prerequisites: [] }],
  };
}

/** ノードを外す。ほかのノードの前提からも外す。 */
export function removeNode(draft: MapDraft, ref: string): MapDraft {
  return {
    ...draft,
    nodes: draft.nodes
      .filter((node) => node.ref !== ref)
      .map((node) => ({
        ...node,
        prerequisites: node.prerequisites.filter((prerequisite) => prerequisite !== ref),
      })),
  };
}

/** 手で作ったノードの表示名・概要を直す。参照のノードは書き換えない。 */
export function updateOwnNode(
  draft: MapDraft,
  ref: string,
  patch: Partial<{ label: string; summary: string }>,
): MapDraft {
  return {
    ...draft,
    nodes: draft.nodes.map((node) =>
      node.ref === ref && node.kind === "own" ? { ...node, ...patch } : node,
    ),
  };
}

/**
 * `ref` の前提に選べるノード。自分自身と、`ref` を前提に辿れるノード（選ぶと循環する）を除く。
 */
export function prerequisiteCandidates(draft: MapDraft, ref: string): DraftNode[] {
  const downstream = descendantsOf(draft, ref);
  return draft.nodes.filter((node) => node.ref !== ref && !downstream.has(node.ref));
}

/** `ref` を前提に（直接・間接に）持つノード。 */
function descendantsOf(draft: MapDraft, ref: string): Set<string> {
  const found = new Set<string>();
  const queue = [ref];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const node of draft.nodes) {
      if (node.prerequisites.includes(current) && !found.has(node.ref)) {
        found.add(node.ref);
        queue.push(node.ref);
      }
    }
  }
  return found;
}

/**
 * 前提を付け外しする。循環する組み合わせは付けない（候補にも出さないが、入口でも弾く）。
 */
export function togglePrerequisite(draft: MapDraft, ref: string, prerequisite: string): MapDraft {
  const node = draft.nodes.find((candidate) => candidate.ref === ref);
  if (node === undefined) return draft;
  const has = node.prerequisites.includes(prerequisite);
  if (
    !has &&
    !prerequisiteCandidates(draft, ref).some((candidate) => candidate.ref === prerequisite)
  ) {
    return draft;
  }
  return {
    ...draft,
    nodes: draft.nodes.map((candidate) =>
      candidate.ref === ref
        ? {
            ...candidate,
            prerequisites: has
              ? candidate.prerequisites.filter((value) => value !== prerequisite)
              : [...candidate.prerequisites, prerequisite],
          }
        : candidate,
    ),
  };
}

/** 保存できない理由。空なら保存できる。上限は入力欄でも止めるが、貼り付けなどに備えてここでも見る。 */
export function draftProblems(draft: MapDraft): string[] {
  const problems: string[] = [];
  if (draft.title.trim() === "") problems.push("題名を入力してください。");
  if (draft.title.trim().length > EDITOR_LIMITS.title) {
    problems.push(`題名は ${String(EDITOR_LIMITS.title)} 文字までです。`);
  }
  if (draft.description.trim().length > EDITOR_LIMITS.description) {
    problems.push(`説明は ${String(EDITOR_LIMITS.description)} 文字までです。`);
  }
  if (draft.nodes.length > EDITOR_LIMITS.nodes) {
    problems.push(`ノードは ${String(EDITOR_LIMITS.nodes)} 個までです。`);
  }
  draft.nodes.forEach((node, index) => {
    if (node.kind !== "own") return;
    const name = node.label.trim() || `${String(index + 1)} 番目のノード`;
    if (node.label.trim() === "") problems.push(`${name}：表示名を入力してください。`);
    if (node.label.trim().length > EDITOR_LIMITS.label) {
      problems.push(`${name}：表示名は ${String(EDITOR_LIMITS.label)} 文字までです。`);
    }
    // 概要は確認問題を作るときの入力になるので必須（#242）。
    if (node.summary.trim() === "") problems.push(`${name}：概要を入力してください。`);
    if (node.summary.trim().length > EDITOR_LIMITS.summary) {
      problems.push(`${name}：概要は ${String(EDITOR_LIMITS.summary)} 文字までです。`);
    }
  });
  return problems;
}

/** `PUT /v1/learning-maps/:id` の本文。 */
export interface MapContentRequest {
  title: string;
  description: string;
  nodes: (
    | { kind: "own"; ref: string; label: string; summary: string }
    | { kind: "reference"; conceptId: string }
  )[];
  edges: { from: string; to: string }[];
}

export function toContentRequest(draft: MapDraft): MapContentRequest {
  return {
    title: draft.title.trim(),
    description: draft.description.trim(),
    nodes: draft.nodes.map((node) =>
      node.kind === "own"
        ? { kind: "own", ref: node.ref, label: node.label.trim(), summary: node.summary.trim() }
        : { kind: "reference", conceptId: node.ref },
    ),
    edges: draft.nodes.flatMap((node) =>
      node.prerequisites.map((prerequisite) => ({ from: prerequisite, to: node.ref })),
    ),
  };
}

/**
 * 保存すると消える、保存済みの手作りのノード。そのノードの「理解すること」と確認問題も
 * 消えるので（#242）、保存の前に確かめる。
 */
export function removedSavedNodes(map: LearningMapView, draft: MapDraft): string[] {
  const kept = new Set(draft.nodes.map((node) => node.ref));
  return map.nodes
    .filter((node) => node.kind === "own" && !kept.has(node.conceptId))
    .map((node) => (node.kind === "own" ? node.label : node.conceptId));
}

/** 下書きが保存済みの中身と違うか。画面を離れる前の確認に使う。 */
export function isDirty(map: LearningMapView, draft: MapDraft): boolean {
  return (
    JSON.stringify(toContentRequest(draftFromMap(map))) !== JSON.stringify(toContentRequest(draft))
  );
}

/** プレビュー（`SkillTree`）に渡す定義。空の表示名は「（無題）」で出す。 */
export function previewDefinitions(draft: MapDraft): DomainConcept[] {
  return draft.nodes.map((node) => ({
    id: node.ref,
    label: node.label.trim() || "（無題）",
    language: "draft",
    prerequisites: node.prerequisites,
    source: { kind: "manual" },
  }));
}
