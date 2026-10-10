/**
 * 下書きの画面（Issue #322）の「用語の候補」と「読んだ材料」の部品。
 * 並べ方・絞り込み・件数の判断は `repo-maps.ts`（テストあり）に置き、ここは描画だけを持つ。
 */

import {
  asNodeKind,
  EVIDENCE_KIND_LABELS,
  REPO_MAP_NODE_KIND_LABELS,
  REPO_MAP_NODE_KINDS,
  type RepoMapNodeKind,
  evidenceCounts,
  groupByEvidenceKind,
  REPO_MAP_LIMITS,
  splitPath,
  type RepoMapCandidate,
  type RepoMapMaterial,
} from "./repo-maps.js";
import { EvidenceLink } from "./repo-map-ui.js";

interface Edit {
  name?: string;
  description?: string;
  /** 直した種類。`null` は「種類なし」に直した。 */
  kind?: RepoMapNodeKind | null;
}

/** 候補 1 件。1 行に畳み、「直す」を押したときだけ入力欄を開く。 */
export function CandidateRow({
  candidate,
  checked,
  editing,
  edit,
  disabled,
  onToggle,
  onToggleEditing,
  onEdit,
}: {
  candidate: RepoMapCandidate;
  checked: boolean;
  editing: boolean;
  edit: Edit | undefined;
  disabled: boolean;
  onToggle: () => void;
  onToggleEditing: () => void;
  onEdit: (patch: Edit) => void;
}) {
  const name = edit?.name ?? candidate.name;
  const description = edit?.description ?? candidate.description;
  const kind = edit?.kind !== undefined ? edit.kind : (candidate.kind ?? null);
  const changed =
    edit !== undefined &&
    (edit.name !== undefined || edit.description !== undefined || edit.kind !== undefined);
  return (
    <li className={`repo-candidate${checked ? "" : " off"}`}>
      <div className="repo-candidate-row">
        <label className="check-consent-remember">
          <input type="checkbox" checked={checked} disabled={disabled} onChange={onToggle} />
          <strong>{name}</strong>
          {candidate.original !== "" && candidate.original !== candidate.name && (
            <code>{candidate.original}</code>
          )}
        </label>
        <span className="repo-candidate-badges">
          {candidate.schemaOnly && <span className="badge-chip">データの形のみ</span>}
          {!candidate.schemaOnly && candidate.fromSchema && (
            <span className="badge-chip">データの形にも</span>
          )}
          {checked ? (
            <select
              className={`kind-select${kind === null ? "" : ` kind-${kind}`}`}
              value={kind ?? ""}
              aria-label={`${name} の種類`}
              disabled={disabled}
              onChange={(event) => onEdit({ kind: asNodeKind(event.target.value) })}
            >
              <option value="">種類なし</option>
              {REPO_MAP_NODE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {REPO_MAP_NODE_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          ) : (
            kind !== null && (
              <span className={`badge-chip kind-${kind}`}>{REPO_MAP_NODE_KIND_LABELS[kind]}</span>
            )
          )}
          {changed && <span className="badge-chip">直した</span>}
          {checked && (
            <button type="button" className="link" disabled={disabled} onClick={onToggleEditing}>
              {editing ? "閉じる" : "直す"}
            </button>
          )}
        </span>
      </div>
      <p className="repo-candidate-description">{description}</p>
      {editing && checked && (
        <div className="repo-candidate-edit">
          <label>
            表示名
            <input
              value={name}
              maxLength={REPO_MAP_LIMITS.name}
              disabled={disabled}
              onChange={(event) => onEdit({ name: event.target.value })}
            />
          </label>
          <label>
            説明
            <textarea
              rows={2}
              value={description}
              maxLength={REPO_MAP_LIMITS.description}
              disabled={disabled}
              onChange={(event) => onEdit({ description: event.target.value })}
            />
          </label>
        </div>
      )}
      <details className="repo-candidate-evidence">
        <summary>
          根拠 {candidate.evidence.length} 件（{evidenceCounts(candidate.evidence)}）
        </summary>
        <ul>
          {candidate.evidence.map((e) => (
            <li key={e.id}>
              <EvidenceLink kind={e.kind} label={e.ref} url={e.url} />
            </li>
          ))}
        </ul>
      </details>
    </li>
  );
}

/** 読んだ材料を、種類ごとに畳んで並べる。外す材料を選べる。 */
export function MaterialGroups({
  materials,
  schemaFiles,
  excluded,
  disabled,
  onToggle,
}: {
  materials: readonly RepoMapMaterial[];
  schemaFiles: readonly { path: string; url: string; names: string[] }[];
  excluded: ReadonlySet<string>;
  disabled: boolean;
  onToggle: (id: string) => void;
}) {
  const rows = [
    ...materials.map((m) => ({
      id: m.id,
      kind: m.kind,
      ref: m.ref,
      url: m.url,
      text: m.text,
      pinned: m.pinned,
    })),
    ...schemaFiles.map((f, i) => ({
      id: `S${String(i + 1)}`,
      kind: "schema" as const,
      ref: f.path,
      url: f.url,
      text: f.names.slice(0, 8).join("、"),
      pinned: false,
    })),
  ];
  return (
    <div className="repo-materials">
      {groupByEvidenceKind(rows).map((group) => (
        <details key={group.kind} open={group.kind !== "code"}>
          <summary>
            {EVIDENCE_KIND_LABELS[group.kind]}（{group.items.length} 件）
          </summary>
          <ul>
            {group.items.map((m) => {
              const { dir, base } =
                group.kind === "issue" ? { dir: "", base: m.ref } : splitPath(m.ref);
              return (
                <li key={m.id} className={excluded.has(m.id) ? "off" : undefined}>
                  <label className="check-consent-remember">
                    <input
                      type="checkbox"
                      checked={excluded.has(m.id)}
                      disabled={disabled}
                      onChange={() => onToggle(m.id)}
                    />
                    外す
                  </label>{" "}
                  <a href={m.url} target="_blank" rel="noreferrer noopener" className="link">
                    <strong>{base}</strong>
                  </a>
                  {dir !== "" && <span className="muted"> {dir}</span>}
                  {m.pinned && <span className="badge-chip">指定</span>}
                  <p className="muted repo-material-text">{m.text}</p>
                </li>
              );
            })}
          </ul>
        </details>
      ))}
    </div>
  );
}
