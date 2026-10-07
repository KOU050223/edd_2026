/**
 * AI が作った学習マップの受理と検証（Issue #243）。
 *
 * **形が揃わない応答は、切り詰めずに失敗にする**（確認問題の `checks/response.ts` と同じ）。
 * ノード数の超過、前提が後ろのノードを指す、参照先が候補に無い、項目の数が範囲外、
 * といった応答を「取れた分だけ」保存すると、利用者が頼んでいない形のマップや、
 * 項目の無いノードが残る（#243「項目の無いノードを残さない」）。
 *
 * 上流の封筒から本文を取り出すのは `checks/response.ts` の `readGeneratedText` を使う。
 * ここは本文をマップとして読むだけを見る。
 */

import * as v from "valibot";
import {
  MAX_GENERATED_NODES,
  MAX_GENERATED_OBJECTIVES,
  MAX_MAP_DESCRIPTION_LENGTH,
  MAX_MAP_TITLE_LENGTH,
  MAX_NODE_LABEL_LENGTH,
  MAX_NODE_SUMMARY_LENGTH,
  MAX_OBJECTIVE_LABEL_LENGTH,
  MIN_GENERATED_OBJECTIVES,
} from "../contract/learning-maps.js";

/** マップとして受理できなかった理由。 */
export type MapParseFailure =
  /** 本文が JSON として読めない。 */
  | "not-json"
  /** 必須の項目が無い、文字数や数の上限を超えている、など。 */
  | "shape"
  /** 前提が無いノード・自分より後ろのノードを指している、key が重なっている、など木にならない。 */
  | "structure"
  /** 参照のノードが、渡した候補に無い ID を指している。 */
  | "unknown-reference"
  /** 「理解すること」が、頼んだノードと合わない（足りない・余る・数が範囲外・重複）。 */
  | "objectives";

export type MapParseResult<T> =
  { ok: true; value: T } | { ok: false; reason: MapParseFailure; detail?: string };

export type GeneratedNode =
  | { kind: "own"; key: string; label: string; summary: string; prerequisite?: string }
  | { kind: "reference"; key: string; conceptId: string; prerequisite?: string };

export interface GeneratedSkeleton {
  title: string;
  description: string;
  /** 学ぶ順。前提は必ず自分より前のノード。 */
  nodes: GeneratedNode[];
}

/** 前後の空白を落としたうえで、空でなく上限以内の文字列。 */
function text(max: number) {
  return v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(max));
}

const keySchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,32}$/));

/**
 * 1ノード。指示していないキーは無視し、足りない・違うことは拒否する（`checks/response.ts` と同じ非対称）。
 * 新しいノードと参照のノードは `conceptId` の有無で分ける。両方の形を併せ持つものは拒否する。
 */
const nodeSchema = v.object({
  key: keySchema,
  label: v.optional(text(MAX_NODE_LABEL_LENGTH)),
  summary: v.optional(text(MAX_NODE_SUMMARY_LENGTH)),
  conceptId: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
  prerequisite: v.optional(v.nullable(keySchema)),
});

const skeletonSchema = v.object({
  title: text(MAX_MAP_TITLE_LENGTH),
  description: v.optional(
    v.pipe(v.string(), v.trim(), v.maxLength(MAX_MAP_DESCRIPTION_LENGTH)),
    "",
  ),
  nodes: v.pipe(v.array(nodeSchema), v.minLength(1), v.maxLength(MAX_GENERATED_NODES)),
});

/**
 * 骨組みを読む。
 *
 * @param candidateIds 参照で置いてよい Concept ID（プロンプトに載せた候補）。
 */
export function parseSkeleton(
  text: string,
  candidateIds: ReadonlySet<string>,
): MapParseResult<GeneratedSkeleton> {
  const payload = parseJson(text);
  if (!payload.ok) return payload;
  const parsed = v.safeParse(skeletonSchema, payload.value);
  if (!parsed.success) {
    return { ok: false, reason: "shape", detail: summarizeIssues(parsed.issues) };
  }

  const seenKeys = new Set<string>();
  const seenReferences = new Set<string>();
  const nodes: GeneratedNode[] = [];
  for (const node of parsed.output.nodes) {
    if (seenKeys.has(node.key)) {
      return { ok: false, reason: "structure", detail: `duplicate key: ${node.key}` };
    }
    const prerequisite = node.prerequisite ?? undefined;
    // 前提は自分より前のノードだけ。これで循環が起きず、前提は1つまでの木になる。
    if (prerequisite !== undefined && !seenKeys.has(prerequisite)) {
      return {
        ok: false,
        reason: "structure",
        detail: `prerequisite is not an earlier node: ${node.key} -> ${prerequisite}`,
      };
    }
    seenKeys.add(node.key);
    const withPrerequisite = prerequisite === undefined ? {} : { prerequisite };

    if (node.conceptId !== undefined) {
      if (node.label !== undefined || node.summary !== undefined) {
        return {
          ok: false,
          reason: "shape",
          detail: `reference node must not have label or summary: ${node.key}`,
        };
      }
      if (!candidateIds.has(node.conceptId)) {
        return { ok: false, reason: "unknown-reference", detail: node.conceptId };
      }
      if (seenReferences.has(node.conceptId)) {
        return { ok: false, reason: "structure", detail: `duplicate reference: ${node.conceptId}` };
      }
      seenReferences.add(node.conceptId);
      nodes.push({
        kind: "reference",
        key: node.key,
        conceptId: node.conceptId,
        ...withPrerequisite,
      });
      continue;
    }
    if (node.label === undefined || node.summary === undefined) {
      return { ok: false, reason: "shape", detail: `node needs label and summary: ${node.key}` };
    }
    nodes.push({
      kind: "own",
      key: node.key,
      label: node.label,
      summary: node.summary,
      ...withPrerequisite,
    });
  }
  return {
    ok: true,
    value: { title: parsed.output.title, description: parsed.output.description, nodes },
  };
}

const objectivesSchema = v.object({
  nodes: v.array(
    v.object({
      key: keySchema,
      objectives: v.pipe(
        v.array(text(MAX_OBJECTIVE_LABEL_LENGTH)),
        v.minLength(MIN_GENERATED_OBJECTIVES),
        v.maxLength(MAX_GENERATED_OBJECTIVES),
      ),
    }),
  ),
});

/**
 * 「理解すること」を読む。頼んだノード（`expectedKeys`）のちょうど全部に項目があるときだけ受理する。
 *
 * @returns key → 項目の並び。
 */
export function parseObjectives(
  text: string,
  expectedKeys: readonly string[],
): MapParseResult<Map<string, string[]>> {
  const payload = parseJson(text);
  if (!payload.ok) return payload;
  const parsed = v.safeParse(objectivesSchema, payload.value);
  if (!parsed.success) {
    return { ok: false, reason: "objectives", detail: summarizeIssues(parsed.issues) };
  }
  const expected = new Set(expectedKeys);
  const byKey = new Map<string, string[]>();
  for (const node of parsed.output.nodes) {
    if (!expected.has(node.key) || byKey.has(node.key)) {
      return {
        ok: false,
        reason: "objectives",
        detail: `unexpected or duplicate key: ${node.key}`,
      };
    }
    if (new Set(node.objectives).size !== node.objectives.length) {
      return { ok: false, reason: "objectives", detail: `duplicate objective: ${node.key}` };
    }
    byKey.set(node.key, node.objectives);
  }
  const missing = expectedKeys.find((key) => !byKey.has(key));
  if (missing !== undefined) {
    return { ok: false, reason: "objectives", detail: `missing node: ${missing}` };
  }
  return { ok: true, value: byKey };
}

function parseJson(text: string): MapParseResult<unknown> {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (cause) {
    return {
      ok: false,
      reason: "not-json",
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/** 失敗の原因をログ用の1行へ縮める。利用者へは返さない。 */
function summarizeIssues(issues: readonly v.BaseIssue<unknown>[]): string {
  return issues
    .slice(0, 3)
    .map((issue) => `${v.getDotPath(issue) ?? "(root)"}: ${issue.message}`)
    .join("; ");
}
