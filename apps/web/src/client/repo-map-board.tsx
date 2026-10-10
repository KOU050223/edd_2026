/**
 * 「用語を選ぶ」の画面（Issue #322 の案 H 改）の部品。
 * 左に種類のナビ、中央に種類ごとの列（カードをドラッグして種類を変えられる）、右に選んだ 1 件の詳細。
 * 列への振り分け・手順の判断は `repo-maps.ts`（テストあり）に置き、ここは描画と操作だけを持つ。
 */

import { useState, type DragEvent } from "react";
import { EvidenceLink } from "./repo-map-ui.js";
import {
  asNodeKind,
  CANDIDATE_DRAG_TYPE,
  groupByKind,
  REPO_MAP_LIMITS,
  REPO_MAP_NODE_KIND_LABELS,
  REPO_MAP_NODE_KINDS,
  wizardSteps,
  type RepoMapCandidate,
  type RepoMapNodeKind,
} from "./repo-maps.js";

/** 画面の左上に出す、いまの手順。 */
export function WizardSteps({ current }: { current: 1 | 2 | 3 | 4 | 5 }) {
  return (
    <ol className="wizard-steps" aria-label="作成の手順">
      {wizardSteps(current).map((step, index) => (
        <li
          key={step.label}
          className={`wizard-step ${step.state}`}
          aria-current={step.state === "current" ? "step" : undefined}
        >
          <span className="wizard-step-mark" aria-hidden="true">
            {step.state === "done" ? "✓" : index + 1}
          </span>
          {step.label}
        </li>
      ))}
    </ol>
  );
}

interface Edit {
  name?: string;
  description?: string;
  kind?: RepoMapNodeKind | null;
}

const NONE_LABEL = "種類なし";

function kindLabel(kind: RepoMapNodeKind | null): string {
  return kind === null ? NONE_LABEL : REPO_MAP_NODE_KIND_LABELS[kind];
}

/** 種類の色（`.kind-*` の `--kind-bar`）。種類なしは灰色。 */
function kindClass(kind: RepoMapNodeKind | null): string {
  return kind === null ? "" : `kind-${kind}`;
}

export function KindBoard({
  candidates,
  all,
  selected,
  edits,
  disabled,
  max,
  onToggle,
  onEdit,
}: {
  /** 絞り込み・並べ替えを済ませた候補。 */
  candidates: readonly RepoMapCandidate[];
  /** 絞り込む前の全候補（ナビの件数用）。 */
  all: readonly RepoMapCandidate[];
  selected: ReadonlySet<string>;
  edits: Readonly<Record<string, Edit | undefined>>;
  disabled: boolean;
  max: number;
  onToggle: (id: string) => void;
  onEdit: (id: string, patch: Edit) => void;
}) {
  const [filter, setFilter] = useState<RepoMapNodeKind | null | "all">("all");
  const [focusId, setFocusId] = useState<string>();
  const [over, setOver] = useState<RepoMapNodeKind | null | "none">();

  const kindOf = (c: RepoMapCandidate): RepoMapNodeKind | null =>
    edits[c.id]?.kind !== undefined ? (edits[c.id]?.kind ?? null) : (c.kind ?? null);
  const nameOf = (c: RepoMapCandidate) => edits[c.id]?.name ?? c.name;
  const descriptionOf = (c: RepoMapCandidate) => edits[c.id]?.description ?? c.description;

  const columns = groupByKind(candidates, kindOf);
  const shown = filter === "all" ? columns : columns.filter((c) => c.kind === filter);
  const focused = candidates.find((c) => c.id === focusId) ?? candidates[0];

  const counts = groupByKind(all, kindOf).map((column) => ({
    kind: column.kind,
    total: column.items.length,
    on: column.items.filter((c) => selected.has(c.id)).length,
  }));
  const onTotal = all.filter((c) => selected.has(c.id)).length;

  const drop = (event: DragEvent, kind: RepoMapNodeKind | null) => {
    event.preventDefault();
    setOver(undefined);
    const id = event.dataTransfer.getData(CANDIDATE_DRAG_TYPE);
    if (disabled || id === "" || !all.some((c) => c.id === id)) return;
    onEdit(id, { kind });
    setFocusId(id);
  };

  return (
    <div className="kind-board">
      <nav className="kind-nav" aria-label="種類">
        <button
          type="button"
          className={filter === "all" ? "active" : undefined}
          onClick={() => setFilter("all")}
        >
          <span>すべて</span>
          <em>
            {onTotal} / {all.length}
          </em>
        </button>
        {counts
          .filter((c) => c.kind !== null || c.total > 0)
          .map((c) => (
            <button
              key={c.kind ?? "none"}
              type="button"
              className={`${kindClass(c.kind)}${filter === c.kind ? " active" : ""}`}
              onClick={() => setFilter(c.kind)}
            >
              <span className="kind-swatch" aria-hidden="true" />
              <span>{kindLabel(c.kind)}</span>
              <em>
                {c.on} / {c.total}
              </em>
            </button>
          ))}
      </nav>

      <div className="kind-columns">
        {shown.map((column) => (
          <section
            key={column.kind ?? "none"}
            className={`kind-column ${kindClass(column.kind)}${
              over === (column.kind ?? "none") ? " over" : ""
            }`}
            aria-label={kindLabel(column.kind)}
            onDragOver={(event) => {
              if (disabled || !event.dataTransfer.types.includes(CANDIDATE_DRAG_TYPE)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setOver(column.kind ?? "none");
            }}
            onDragLeave={() => setOver(undefined)}
            onDrop={(event) => drop(event, column.kind)}
          >
            <h3>
              {kindLabel(column.kind)}
              <span>
                {column.items.filter((c) => selected.has(c.id)).length}/{column.items.length}
              </span>
            </h3>
            {column.items.length === 0 && (
              <p className="kind-empty">ここへドラッグすると、この種類にできます</p>
            )}
            <ul>
              {column.items.map((c) => (
                <li
                  key={c.id}
                  className={`kind-card${selected.has(c.id) ? " on" : ""}${
                    focused?.id === c.id ? " cur" : ""
                  }`}
                  draggable={!disabled}
                  onDragStart={(event) => {
                    event.dataTransfer.setData(CANDIDATE_DRAG_TYPE, c.id);
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  onDragEnd={() => setOver(undefined)}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(c.id)}
                    disabled={disabled}
                    aria-label={`${nameOf(c)} を入れる`}
                    onChange={() => onToggle(c.id)}
                  />
                  <button type="button" className="kind-card-body" onClick={() => setFocusId(c.id)}>
                    <strong>{nameOf(c)}</strong>
                    <i>
                      根拠 {c.evidence.length}
                      {c.schemaOnly ? "・データの形のみ" : ""}
                      {edits[c.id] !== undefined ? "・直した" : ""}
                    </i>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {shown.length === 0 && <p className="muted">一致する候補がありません。</p>}
        {filter === "all" && (
          <p className="kind-hint muted">
            カードを別の列へドラッグすると、種類を変えられます。選んだ数は、上限 {max} 個までです。
          </p>
        )}
      </div>

      {focused !== undefined && (
        <aside className={`kind-detail ${kindClass(kindOf(focused))}`} aria-label="選んだ用語">
          <span className="kind-label">{kindLabel(kindOf(focused))}</span>
          <h3>{nameOf(focused)}</h3>
          {focused.original !== "" && focused.original !== focused.name && (
            <code>{focused.original}</code>
          )}
          <label>
            表示名
            <input
              value={nameOf(focused)}
              maxLength={REPO_MAP_LIMITS.name}
              disabled={disabled}
              onChange={(event) => onEdit(focused.id, { name: event.target.value })}
            />
          </label>
          <label>
            説明
            <textarea
              rows={3}
              value={descriptionOf(focused)}
              maxLength={REPO_MAP_LIMITS.description}
              disabled={disabled}
              onChange={(event) => onEdit(focused.id, { description: event.target.value })}
            />
          </label>
          <label>
            種類
            <select
              value={kindOf(focused) ?? ""}
              disabled={disabled}
              onChange={(event) => onEdit(focused.id, { kind: asNodeKind(event.target.value) })}
            >
              <option value="">{NONE_LABEL}</option>
              {REPO_MAP_NODE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {REPO_MAP_NODE_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          <h4>根拠 {focused.evidence.length} 件</h4>
          <ul>
            {focused.evidence.map((e) => (
              <li key={e.id}>
                <EvidenceLink kind={e.kind} label={e.ref} url={e.url} />
              </li>
            ))}
          </ul>
        </aside>
      )}
    </div>
  );
}
