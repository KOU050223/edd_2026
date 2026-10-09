/**
 * 共有の版の中身と差分の表示（Issue #244）。確認画面（S1-a）と版の履歴で使う。
 *
 * 確認画面は「共有すると外へ出ていくもの」を作成者に確かめさせるためにある。
 * だから表示名・概要・「理解すること」・確認問題の設問を、省略せずに文字のまま並べる。
 */

import type { PersonalConceptCheck } from "@gakushu-sochi/domain";
import { MISSING_ORIGIN_LABEL, type LearningMapNodeView } from "./learning-maps.js";
import {
  describeChangedFields,
  isEmptyDiff,
  nodeLabel,
  type LearningMapDiff,
  type SharedMapContentView,
} from "./map-sharing.js";

/**
 * ノード1つ。参照のノードも、元の表示名・概要・「理解すること」を省略せずに出す
 * （持ち主の別のマップのノードを参照していると、その中身も版へ写って出ていくため。PR #294 のレビュー）。
 */
function NodeBody({ node, prerequisite }: { node: LearningMapNodeView; prerequisite?: string }) {
  const shown =
    node.kind === "own"
      ? node
      : {
          label: node.origin?.label ?? MISSING_ORIGIN_LABEL,
          summary: node.origin?.summary,
          objectives: node.origin?.objectives ?? [],
        };
  return (
    <>
      <strong>{shown.label}</strong>
      {node.kind === "reference" && <span className="muted">（既存の Concept の参照）</span>}
      {prerequisite !== undefined && <p className="muted">前提: {prerequisite}</p>}
      {shown.summary && <p className="muted">{shown.summary}</p>}
      {shown.objectives.length > 0 && (
        <ul className="share-objectives">
          {shown.objectives.map((objective) => (
            <li key={objective.id}>{objective.label}</li>
          ))}
        </ul>
      )}
    </>
  );
}

function CheckList({
  checks,
  labelOf,
}: {
  checks: readonly PersonalConceptCheck[];
  labelOf: (conceptId: string) => string;
}) {
  return (
    <ul className="share-checks">
      {checks.map((check) => (
        <li key={`${check.conceptId}\n${check.objectiveId ?? "concept"}`}>
          <span className="muted">{labelOf(check.conceptId)}</span>
          <p>概要問題: {check.overview.prompt}</p>
          <p>実践問題: {check.practice.prompt}</p>
        </li>
      ))}
    </ul>
  );
}

/** ノードの Concept ID から表示名を引く。見つからなければ ID のまま。 */
function labelLookup(nodes: readonly LearningMapNodeView[]) {
  const labels = new Map(nodes.map((node) => [node.conceptId, nodeLabel(node)]));
  return (conceptId: string) => labels.get(conceptId) ?? conceptId;
}

/** 版の中身の全部。 */
export function MapContentList({ content }: { content: SharedMapContentView }) {
  const labelOf = labelLookup(content.nodes);
  // 前提は1つのノードにつき1つまで（#242）。
  const prerequisiteOf = new Map(content.edges.map((edge) => [edge.to, edge.from]));
  return (
    <div className="share-content">
      <p>
        <strong>題名:</strong> {content.title}
      </p>
      {content.description && (
        <p>
          <strong>説明:</strong> {content.description}
        </p>
      )}
      <h3>ノード（{content.nodes.length}）</h3>
      {content.nodes.length === 0 ? (
        <p className="muted">ノードはありません。</p>
      ) : (
        <ol className="share-nodes">
          {content.nodes.map((node) => {
            const prerequisite = prerequisiteOf.get(node.conceptId);
            return (
              <li key={node.conceptId}>
                <NodeBody
                  node={node}
                  prerequisite={prerequisite === undefined ? "なし" : labelOf(prerequisite)}
                />
              </li>
            );
          })}
        </ol>
      )}
      <h3>確認問題（{content.checks.length} 組）</h3>
      {content.checks.length === 0 ? (
        <p className="muted">共有する確認問題はありません。</p>
      ) : (
        <CheckList checks={content.checks} labelOf={labelOf} />
      )}
    </div>
  );
}

/** 2つの版（または手元と版）の差分。 */
export function MapDiffList({
  diff,
  content,
}: {
  diff: LearningMapDiff;
  /** 差分の後ろ側の中身。前提のノードの表示名を引くのに使う。 */
  content: SharedMapContentView;
}) {
  if (isEmptyDiff(diff)) return <p className="muted">変わったところはありません。</p>;
  const labelOf = labelLookup([...diff.removed, ...content.nodes]);
  const prerequisite = (conceptId: string | null) =>
    conceptId === null ? "なし" : labelOf(conceptId);
  return (
    <div className="share-diff">
      {diff.title && (
        <p>
          <strong>題名:</strong> {diff.title.before || "（なし）"} → {diff.title.after}
        </p>
      )}
      {diff.description && (
        <p>
          <strong>説明:</strong> {diff.description.before || "（なし）"} →{" "}
          {diff.description.after || "（なし）"}
        </p>
      )}
      {diff.reordered && (
        <p>
          <strong>ノードの並び（学習の順）を変えました。</strong>
        </p>
      )}
      {diff.added.length > 0 && (
        <>
          <h3>足したノード（{diff.added.length}）</h3>
          <ul className="share-nodes added">
            {diff.added.map((node) => (
              <li key={node.conceptId}>
                <NodeBody node={node} />
              </li>
            ))}
          </ul>
        </>
      )}
      {diff.removed.length > 0 && (
        <>
          <h3>消したノード（{diff.removed.length}）</h3>
          <ul className="share-nodes removed">
            {diff.removed.map((node) => (
              <li key={node.conceptId}>
                <strong>{nodeLabel(node) ?? MISSING_ORIGIN_LABEL}</strong>
              </li>
            ))}
          </ul>
        </>
      )}
      {diff.changed.length > 0 && (
        <>
          <h3>変えたノード（{diff.changed.length}）</h3>
          <ul className="share-nodes changed">
            {diff.changed.map((change) => (
              <li key={change.conceptId}>
                <p>
                  <strong>{nodeLabel(change.after) ?? MISSING_ORIGIN_LABEL}</strong>
                  <span className="muted">（{describeChangedFields(change.fields)}）</span>
                </p>
                {change.fields.includes("prerequisite") && (
                  <p className="muted">
                    前提: {prerequisite(change.prerequisiteBefore)} →{" "}
                    {prerequisite(change.prerequisiteAfter)}
                  </p>
                )}
                <div className="share-before-after">
                  <div>
                    <span className="muted">前</span>
                    <NodeBody node={change.before} />
                  </div>
                  <div>
                    <span className="muted">後</span>
                    <NodeBody node={change.after} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {diff.checks.added.length > 0 && (
        <>
          <h3>足した確認問題（{diff.checks.added.length} 組）</h3>
          <CheckList checks={diff.checks.added} labelOf={labelOf} />
        </>
      )}
      {diff.checks.removed.length > 0 && (
        <>
          <h3>外した確認問題（{diff.checks.removed.length} 組）</h3>
          <CheckList checks={diff.checks.removed} labelOf={labelOf} />
        </>
      )}
    </div>
  );
}
