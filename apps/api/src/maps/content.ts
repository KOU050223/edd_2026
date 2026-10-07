/**
 * 学習マップの中身（ノードと線）を検証し、ID を振る（Issue #242）。
 *
 * HTTP も D1 も知らない。ルートが入力を検証したあとに呼び、
 * 保存する形（{@link StoredMapContent}）と、新しいノードへ振った ID を返す。
 * 参照のノードの行き先が実在するか（固定の Concept か、自分の他のマップのノードか）は
 * 保存先を読まないと分からないので、ここでは調べずにルートへ返す。
 */

import { NEW_NODE_REF_PATTERN, type LearningMapContentInput } from "../contract/learning-maps.js";
import type { StoredMapContent, StoredMapNode } from "../repository/types.js";

const KEY_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const KEY_LENGTH = 8;

/**
 * 英小文字と数字 8 文字。マップの ID・ノードの識別子・「理解すること」の識別子に使う。
 *
 * 36 で割った余りを使うと 256 が 36 で割り切れない分だけ偏るので、
 * 252（36 の倍数）以上のバイトは捨てて引き直す。
 */
export function randomKey(): string {
  let key = "";
  while (key.length < KEY_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(KEY_LENGTH * 2));
    for (const byte of bytes) {
      if (byte >= 252) continue;
      key += KEY_ALPHABET[byte % 36];
      if (key.length === KEY_LENGTH) break;
    }
  }
  return key;
}

/** マップの ID。`m` + 英小文字と数字 8 文字（例: `m7k2x9qa4`）。 */
export function newMapId(newKey: () => string): string {
  return `m${newKey()}`;
}

export type ResolveMapContentResult =
  | {
      ok: true;
      content: StoredMapContent;
      /** 新しいノードの仮の番号 → 振った Concept ID。 */
      assigned: Record<string, string>;
      /** 参照のノードが指す Concept ID。実在の確認はルートが行う。 */
      referenceIds: string[];
    }
  | { ok: false; error: string };

/**
 * 入力のノードと線を、保存する形へ変える。
 *
 * @param existingOwnIds このマップに今あるノード（参照ではないもの）の Concept ID。
 *   既存のノードはこの中の ID でしか指せない。新しく作るマップなら空。
 */
export function resolveMapContent(
  mapId: string,
  input: LearningMapContentInput,
  existingOwnIds: ReadonlySet<string>,
  newKey: () => string,
): ResolveMapContentResult {
  const ownPrefix = `${mapId}.`;
  const assigned: Record<string, string> = {};
  const referenceIds: string[] = [];
  // 入力の ref（参照のノードなら conceptId）→ 保存する Concept ID。線の解決に使う。
  const conceptIdByRef = new Map<string, string>();
  const nodes: StoredMapNode[] = [];

  for (const node of input.nodes) {
    const ref = node.kind === "own" ? node.ref : node.conceptId;
    if (conceptIdByRef.has(ref)) {
      return { ok: false, error: `duplicate node: ${ref}` };
    }

    if (node.kind === "reference") {
      // このマップのノードを参照で置くと、同じ Concept が2つ並ぶ。
      if (node.conceptId.startsWith(ownPrefix)) {
        return { ok: false, error: `cannot reference a node of the same map: ${node.conceptId}` };
      }
      conceptIdByRef.set(ref, node.conceptId);
      referenceIds.push(node.conceptId);
      nodes.push({ kind: "reference", conceptId: node.conceptId });
      continue;
    }

    let conceptId: string;
    if (NEW_NODE_REF_PATTERN.test(node.ref)) {
      conceptId = `${ownPrefix}${uniqueKey(newKey, ownPrefix, existingOwnIds, conceptIdByRef)}`;
      assigned[node.ref] = conceptId;
    } else if (existingOwnIds.has(node.ref)) {
      conceptId = node.ref;
    } else {
      return { ok: false, error: `unknown node: ${node.ref}` };
    }
    conceptIdByRef.set(ref, conceptId);
    nodes.push({ kind: "own", conceptId, label: node.label, summary: node.summary });
  }

  const edges: StoredMapContent["edges"] = [];
  const seenEdges = new Set<string>();
  for (const edge of input.edges) {
    const from = conceptIdByRef.get(edge.from);
    const to = conceptIdByRef.get(edge.to);
    if (from === undefined || to === undefined) {
      return {
        ok: false,
        error: `edge points to a node not in this map: ${edge.from} -> ${edge.to}`,
      };
    }
    if (from === to) {
      return { ok: false, error: `edge must not point to itself: ${edge.from}` };
    }
    // Concept ID は空白を含まないので、空白で連結しても一意なキーになる。
    const key = `${from} ${to}`;
    if (seenEdges.has(key)) {
      return { ok: false, error: `duplicate edge: ${edge.from} -> ${edge.to}` };
    }
    seenEdges.add(key);
    edges.push({ from, to });
  }

  if (hasCycle(nodes, edges)) {
    return { ok: false, error: "edges must not form a cycle" };
  }

  return {
    ok: true,
    content: { title: input.title, description: input.description, nodes, edges },
    assigned,
    referenceIds,
  };
}

/** このマップの中でまだ使っていない識別子を引く。 */
function uniqueKey(
  newKey: () => string,
  ownPrefix: string,
  existingOwnIds: ReadonlySet<string>,
  used: ReadonlyMap<string, string>,
): string {
  const taken = new Set([...existingOwnIds, ...used.values()]);
  // 8 文字で 36^8 通りあるので、50 ノードで衝突することはまず無い。
  // それでも引き直しが続くなら乱数の側が壊れているので、黙って回し続けない。
  for (let attempt = 0; attempt < 10; attempt++) {
    const key = newKey();
    if (!taken.has(`${ownPrefix}${key}`)) return key;
  }
  throw new Error("could not assign a unique node id");
}

/**
 * 線が循環しているか。入ってくる線の無いノードから順に外していき（Kahn 法）、
 * 外しきれないノードが残れば循環がある。
 */
function hasCycle(
  nodes: readonly StoredMapNode[],
  edges: readonly StoredMapContent["edges"][number][],
): boolean {
  const incoming = new Map<string, number>(nodes.map((node) => [node.conceptId, 0]));
  const next = new Map<string, string[]>();
  for (const { from, to } of edges) {
    incoming.set(to, (incoming.get(to) ?? 0) + 1);
    next.set(from, [...(next.get(from) ?? []), to]);
  }
  const queue = [...incoming].filter(([, count]) => count === 0).map(([id]) => id);
  let removed = 0;
  while (queue.length > 0) {
    const id = queue.pop()!;
    removed++;
    for (const to of next.get(id) ?? []) {
      const count = incoming.get(to)! - 1;
      incoming.set(to, count);
      if (count === 0) queue.push(to);
    }
  }
  return removed < incoming.size;
}
