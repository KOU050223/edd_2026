/**
 * リポジトリから作ったマップの根拠の表示（#249、#322）。選んだノードの右パネルに、読んだ文書・コード・Issue の
 * リンクと要約を種類ごとに出す。リンクは、読んだ時点の commit SHA で固定されている
 * （リポジトリが変わっても、根拠の指す中身は変わらない）。
 */

import {
  EVIDENCE_KIND_LABELS,
  evidenceCounts,
  groupByEvidenceKind,
  splitPath,
  type RepoMapSourcesState,
} from "./repo-maps.js";

/** 根拠を読み込めなかったときの知らせ。マップの閲覧は止めないが、黙って消さない。 */
export function RepoMapSourcesFailure({ state }: { state: RepoMapSourcesState }) {
  if (state.kind !== "failed") return null;
  return (
    <section className="message error" role="alert">
      <p>このマップの根拠（読んだ文書・コード）を読み込めませんでした。再読み込みしてください。</p>
    </section>
  );
}

/** 選んだノード 1 つの根拠。右パネルの中に置く。リポジトリから作ったマップでなければ何も出さない。 */
export function RepoMapNodeSources({
  state,
  conceptId,
}: {
  state: RepoMapSourcesState | undefined;
  conceptId: string;
}) {
  if (state === undefined || state.kind !== "ok") return null;
  const { sources } = state;
  const node = sources.nodes.find((n) => n.conceptId === conceptId);
  const items = node?.sources ?? [];
  return (
    <section className="detail-block repo-sources" aria-label="根拠">
      <h3 className="detail-block-title">根拠</h3>
      {items.length === 0 ? (
        <p className="muted">
          このノードには、リポジトリの根拠がありません（あとから足したノードです）。
        </p>
      ) : (
        <>
          <p className="muted">
            {items.length} 件（{evidenceCounts(items)}）
          </p>
          {groupByEvidenceKind(items).map((group) => (
            <div key={group.kind}>
              <h4>{EVIDENCE_KIND_LABELS[group.kind]}</h4>
              <ul>
                {group.items.map((s, i) => {
                  const label = s.kind === "issue" ? `#${String(s.issueNumber)}` : (s.path ?? "");
                  const { dir, base } =
                    s.kind === "issue" ? { dir: "", base: label } : splitPath(label);
                  return (
                    <li key={`${group.kind}:${String(i)}`}>
                      <a href={s.url} target="_blank" rel="noreferrer noopener" className="link">
                        <strong>{base}</strong>
                      </a>
                      {dir !== "" && <span className="muted"> {dir}</span>}
                      <p className="muted repo-source-summary">{s.summary}</p>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </>
      )}
      <p className="muted">
        GitHub の {sources.repo.url}（{sources.repo.commitSha.slice(0, 7)} 時点）から作りました。
      </p>
    </section>
  );
}
