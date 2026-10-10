/**
 * リポジトリから作ったマップの根拠の表示（#249）。ノードごとに、読んだ文書・コード・Issue のリンクと要約を出す。
 * リンクは、読んだ時点の commit SHA で固定されている（リポジトリが変わっても、根拠の指す中身は変わらない）。
 */

import { EVIDENCE_KIND_LABELS, type RepoMapSourcesState } from "./repo-maps.js";

export function RepoMapSourcesPanel({
  state,
  selectedId,
  labelOf,
}: {
  state: RepoMapSourcesState;
  selectedId: string | undefined;
  labelOf: (conceptId: string) => string;
}) {
  if (state.kind === "failed") {
    return (
      <section className="message error" role="alert">
        <p>
          このマップの根拠（読んだ文書・コード）を読み込めませんでした。再読み込みしてください。
        </p>
      </section>
    );
  }
  if (state.kind !== "ok") return null;
  const { sources } = state;
  // ノードを選んでいれば、そのノードの根拠だけを出す（根拠が無いノードに、ほかのノードの根拠を出さない）。
  const nodes =
    selectedId === undefined
      ? sources.nodes
      : sources.nodes.filter((n) => n.conceptId === selectedId);
  return (
    <section className="repo-sources" aria-label="根拠">
      <h2>根拠</h2>
      <p className="muted">
        GitHub の {sources.repo.url}（{sources.repo.commitSha.slice(0, 7)} 時点）から作りました。
      </p>
      {nodes.length === 0 && (
        <p className="muted">
          選んだノードには、リポジトリの根拠がありません（あとから足したノードです）。
        </p>
      )}
      {nodes.map((node) => (
        <div key={node.conceptId}>
          <h3>{labelOf(node.conceptId)}</h3>
          <ul>
            {node.sources.map((s, i) => (
              <li key={`${node.conceptId}:${String(i)}`}>
                <a href={s.url} target="_blank" rel="noreferrer noopener" className="link">
                  {EVIDENCE_KIND_LABELS[s.kind]}:{" "}
                  {s.kind === "issue" ? `#${String(s.issueNumber)}` : (s.path ?? "")}
                </a>
                <span className="muted"> — {s.summary}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
