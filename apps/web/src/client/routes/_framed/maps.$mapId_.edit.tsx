import { createFileRoute, Link, useBlocker, useRouter } from "@tanstack/react-router";
import { CONCEPTS } from "@gakushu-sochi/domain";
import { useMemo, useRef, useState } from "react";
import { ApiError, createSubmitGuard } from "../../api.js";
import { toErrorText } from "../../errors.js";
import { layoutTrees } from "../../learning-map.js";
import { languageLabel, overlaidConcepts, SkillTree } from "../../learning-map-view.js";
import {
  fetchLearningMap,
  fetchOwnMapConcepts,
  MapInputError,
  saveLearningMap,
  saveObjectives,
  type LearningMapView,
  type LearningObjectiveView,
} from "../../learning-maps.js";
import {
  addOwnNode,
  addReference,
  draftFromMap,
  draftProblems,
  EDITOR_LIMITS,
  isDirty,
  prerequisiteCandidates,
  previewDefinitions,
  removedSavedNodes,
  removeNode,
  toContentRequest,
  togglePrerequisite,
  updateOwnNode,
  type DraftNode,
  type MapDraft,
} from "../../map-editor.js";
import { takeLoginRetry } from "../../session.js";

/** 参照で足せる既存の Concept。固定の一覧と、自分の他のマップのノード。 */
interface ReferenceCandidate {
  id: string;
  label: string;
  /** 領域名か、元のマップの題名。 */
  area: string;
}

/** 保存の失敗を、利用者が何をすればよいか分かる文面にする（RULE-004）。 */
function saveErrorText(error: unknown): string {
  if (error instanceof MapInputError) {
    return `入力を受け付けられませんでした。内容を確かめてください（${error.message}）。`;
  }
  return toErrorText(error);
}

/**
 * 1ノードの「理解すること」。ノードの保存とは別に、ノードごとに保存する
 * （API の口が別。AI の生成が同じ口へ書けるようにするため、#242）。
 */
function ObjectivesEditor({
  mapId,
  conceptId,
  saved,
  onSaved,
}: {
  mapId: string;
  conceptId: string;
  saved: readonly LearningObjectiveView[];
  onSaved: (objectives: LearningObjectiveView[]) => void;
}) {
  const [items, setItems] = useState<{ id?: string; label: string }[]>(() =>
    saved.map(({ id, label }) => ({ id, label })),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const guard = useRef(createSubmitGuard());
  const dirty =
    JSON.stringify(items.map((item) => [item.id, item.label.trim()])) !==
    JSON.stringify(saved.map((item) => [item.id, item.label]));
  const blank = items.some((item) => item.label.trim() === "");
  const removed = saved.filter((objective) => !items.some((item) => item.id === objective.id));

  const save = () => {
    if (guard.current.isRunning("save")) return;
    if (
      removed.length > 0 &&
      !window.confirm(
        `${String(removed.length)} 個の項目を消します。その項目を狙って作った確認問題も消えます。`,
      )
    )
      return;
    setError(undefined);
    setSaving(true);
    void guard.current
      .run("save", async () => {
        try {
          const result = await saveObjectives(
            mapId,
            conceptId,
            items.map((item) => ({
              ...(item.id === undefined ? {} : { id: item.id }),
              label: item.label.trim(),
            })),
          );
          setItems(result.objectives.map(({ id, label }) => ({ id, label })));
          onSaved(result.objectives);
        } catch (value: unknown) {
          if (value instanceof ApiError && value.kind === "session_expired") {
            window.location.href = "/login";
            return;
          }
          setError(saveErrorText(value));
        }
      })
      .finally(() => setSaving(false));
  };

  return (
    <fieldset className="editor-objectives">
      <legend>理解すること</legend>
      <p className="muted">
        このノードを理解したと言えるために、分かっているべきこと。確認問題は項目ごとに作れます。
      </p>
      <ol>
        {items.map((item, index) => (
          <li key={item.id ?? `new-${String(index)}`}>
            <input
              value={item.label}
              maxLength={EDITOR_LIMITS.objectiveLabel}
              aria-label={`理解すること ${String(index + 1)}`}
              disabled={saving}
              onChange={(event) =>
                setItems((current) =>
                  current.map((candidate, at) =>
                    at === index ? { ...candidate, label: event.target.value } : candidate,
                  ),
                )
              }
            />
            <button
              className="link"
              disabled={saving}
              onClick={() => setItems((current) => current.filter((_, at) => at !== index))}
            >
              外す
            </button>
          </li>
        ))}
      </ol>
      <div className="editor-row">
        <button
          className="link"
          disabled={saving || items.length >= EDITOR_LIMITS.objectives}
          onClick={() => setItems((current) => [...current, { label: "" }])}
        >
          + 項目を足す
        </button>
        <span className="muted">
          {items.length} / {EDITOR_LIMITS.objectives}
        </span>
        <button disabled={saving || !dirty || blank} onClick={save}>
          {saving ? "保存中…" : "理解することを保存"}
        </button>
      </div>
      {blank && <p className="muted">空の項目があります。入力するか外してください。</p>}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}

/** 既存の Concept を探して参照で足す。 */
function ReferencePicker({
  candidates,
  disabled,
  onAdd,
}: {
  candidates: readonly ReferenceCandidate[];
  disabled: boolean;
  onAdd: (candidate: ReferenceCandidate) => void;
}) {
  const [query, setQuery] = useState("");
  const words = query.trim().toLowerCase();
  const matches =
    words === ""
      ? []
      : candidates
          .filter((candidate) =>
            `${candidate.label} ${candidate.area} ${candidate.id}`.toLowerCase().includes(words),
          )
          .slice(0, 8);
  return (
    <div className="editor-reference">
      <label>
        既存の Concept を参照で足す
        <input
          type="search"
          value={query}
          placeholder="例: defer、Git"
          disabled={disabled}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {words !== "" && matches.length === 0 && <p className="muted">見つかりません。</p>}
      {matches.length > 0 && (
        <ul>
          {matches.map((candidate) => (
            <li key={candidate.id}>
              <span>
                {candidate.label} <span className="muted">（{candidate.area}）</span>
              </span>
              <button
                className="link"
                disabled={disabled}
                onClick={() => {
                  onAdd(candidate);
                  setQuery("");
                }}
              >
                足す
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 1ノードの編集欄。 */
function NodeEditor({
  node,
  draft,
  open,
  mapId,
  savedObjectives,
  disabled,
  onToggle,
  onChange,
  onObjectivesSaved,
}: {
  node: DraftNode;
  draft: MapDraft;
  open: boolean;
  mapId: string;
  /** 保存済みのノードの項目。新しいノードは `undefined`。 */
  savedObjectives: readonly LearningObjectiveView[] | undefined;
  disabled: boolean;
  onToggle: () => void;
  onChange: (draft: MapDraft) => void;
  onObjectivesSaved: (objectives: LearningObjectiveView[]) => void;
}) {
  const nameOfRef = (ref: string) => {
    const label = draft.nodes.find((candidate) => candidate.ref === ref)?.label.trim();
    return label || "（無題）";
  };
  const candidates = prerequisiteCandidates(draft, node.ref);
  const isNew = node.ref.startsWith("new:");
  return (
    <li className={open ? "editor-node open" : "editor-node"}>
      <button className="editor-node-head" aria-expanded={open} onClick={onToggle}>
        <span>{node.label.trim() || "（無題）"}</span>
        {node.kind === "reference" && <em className="badge">参照</em>}
        {isNew && <em className="badge">未保存</em>}
      </button>
      {open && (
        <div className="editor-node-body">
          {node.kind === "own" ? (
            <>
              <label>
                表示名
                <input
                  value={node.label}
                  maxLength={EDITOR_LIMITS.label}
                  disabled={disabled}
                  onChange={(event) =>
                    onChange(updateOwnNode(draft, node.ref, { label: event.target.value }))
                  }
                />
              </label>
              <label>
                概要（確認問題を作るときに AI へ渡します）
                <textarea
                  value={node.summary}
                  maxLength={EDITOR_LIMITS.summary}
                  rows={3}
                  disabled={disabled}
                  onChange={(event) =>
                    onChange(updateOwnNode(draft, node.ref, { summary: event.target.value }))
                  }
                />
              </label>
            </>
          ) : (
            <p className="muted">
              既存の Concept を参照しています。表示名・概要・「理解すること」は元のものを使い、
              ここでは書き換えません。理解度も元の Concept のものが出ます。
            </p>
          )}
          <fieldset>
            <legend>前提（先に学ぶノード）</legend>
            {candidates.length === 0 ? (
              <p className="muted">前提にできるノードがありません。</p>
            ) : (
              candidates.map((candidate) => (
                <label key={candidate.ref} className="editor-check">
                  <input
                    type="checkbox"
                    checked={node.prerequisites.includes(candidate.ref)}
                    disabled={disabled}
                    onChange={() => onChange(togglePrerequisite(draft, node.ref, candidate.ref))}
                  />
                  {nameOfRef(candidate.ref)}
                </label>
              ))
            )}
          </fieldset>
          {node.kind === "own" &&
            (savedObjectives === undefined ? (
              <p className="muted">「理解すること」は、マップを保存すると書けるようになります。</p>
            ) : (
              <ObjectivesEditor
                mapId={mapId}
                conceptId={node.ref}
                saved={savedObjectives}
                onSaved={onObjectivesSaved}
              />
            ))}
          <button
            className="link danger"
            disabled={disabled}
            onClick={() => onChange(removeNode(draft, node.ref))}
          >
            このノードを外す
          </button>
        </div>
      )}
    </li>
  );
}

/**
 * 学習マップの編集（Issue #242、フォーム型）。左に木のプレビュー、右にノードの一覧。
 *
 * ノードと線は下書きに持ち、「保存」でまとめて置き換える（`PUT /v1/learning-maps/:id`）。
 * 配置は保存しない。前提の段数から自動で組み立てる（`layoutTrees`）。
 */
function MapEditor() {
  const { mapId } = Route.useParams();
  const loaded = Route.useLoaderData();
  const router = useRouter();
  const [saved, setSaved] = useState<LearningMapView>(loaded.map);
  const [draft, setDraft] = useState<MapDraft>(() => draftFromMap(loaded.map));
  const [openRef, setOpenRef] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const guard = useRef(createSubmitGuard());

  const dirty = isDirty(saved, draft);
  const problems = draftProblems(draft);
  // 保存していない変更があるまま画面を離れない。
  useBlocker({
    shouldBlockFn: () => !window.confirm("保存していない変更があります。破棄して離れますか？"),
    enableBeforeUnload: dirty,
    disabled: !dirty,
  });

  const candidates = useMemo<ReferenceCandidate[]>(() => {
    const own = loaded.ownConcepts
      // このマップのノードは参照で置かない（同じものが2つ並ぶ）。
      .filter((concept) => concept.mapId !== mapId)
      .map((concept) => ({ id: concept.id, label: concept.label, area: concept.mapTitle }));
    const fixed = CONCEPTS.map((concept) => ({
      id: concept.id,
      label: concept.label,
      area: languageLabel[concept.language] ?? concept.language,
    }));
    return [...own, ...fixed];
  }, [loaded.ownConcepts, mapId]);
  const inDraft = new Set(draft.nodes.map((node) => node.ref));

  const preview = previewDefinitions(draft);
  const tree = layoutTrees(preview)[0];
  const previewConcepts = new Map(
    overlaidConcepts(null, null, preview).map((concept) => [concept.conceptId, concept]),
  );
  const savedObjectivesOf = new Map(
    saved.nodes.flatMap((node) =>
      node.kind === "own" ? [[node.conceptId, node.objectives] as const] : [],
    ),
  );

  const change = (next: MapDraft) => {
    setNotice(undefined);
    setDraft(next);
  };

  const save = () => {
    if (guard.current.isRunning("save") || problems.length > 0) return;
    const removed = removedSavedNodes(saved, draft);
    if (
      removed.length > 0 &&
      !window.confirm(
        `${removed.join("・")} を消します。そのノードの「理解すること」と確認問題も消えます。` +
          "学習の記録は残ります。",
      )
    )
      return;
    setSaveError(undefined);
    setNotice(undefined);
    setSaving(true);
    void guard.current
      .run("save", async () => {
        try {
          const result = await saveLearningMap(mapId, toContentRequest(draft));
          setSaved(result.map);
          setDraft(draftFromMap(result.map));
          // 開いていた新しいノードは、振られた ID で開き直す。
          setOpenRef((current) =>
            current === undefined ? undefined : (result.assigned[current] ?? current),
          );
          setNotice("保存しました。");
          // 表示画面と一覧の loader を捨て、戻ったときに古い中身を見せない（RULE-005）。
          await router.invalidate();
        } catch (value: unknown) {
          if (value instanceof ApiError && value.kind === "session_expired") {
            window.location.href = "/login";
            return;
          }
          setSaveError(saveErrorText(value));
        }
      })
      .finally(() => setSaving(false));
  };

  return (
    <section className="editor">
      <p className="map-head">
        <Link to="/maps/$mapId" params={{ mapId }} className="link">
          ← マップへ戻る
        </Link>
        <h1>マップを編集</h1>
      </p>
      <div className="editor-meta">
        <label>
          題名
          <input
            value={draft.title}
            maxLength={EDITOR_LIMITS.title}
            disabled={saving}
            onChange={(event) => change({ ...draft, title: event.target.value })}
          />
        </label>
        <label>
          説明（任意）
          <textarea
            value={draft.description}
            maxLength={EDITOR_LIMITS.description}
            rows={2}
            disabled={saving}
            onChange={(event) => change({ ...draft, description: event.target.value })}
          />
        </label>
      </div>
      <div className="editor-layout">
        <div className="map">
          {tree === undefined ? (
            <p className="hint">ノードを足すと、ここに木が組み上がります。</p>
          ) : (
            <SkillTree
              tree={tree}
              title="プレビュー"
              concepts={previewConcepts}
              current={undefined}
              next={new Set()}
              selected={openRef}
              onSelect={setOpenRef}
            />
          )}
        </div>
        <div className="editor-nodes">
          <h2>
            ノード{" "}
            <span className="muted">
              {draft.nodes.length} / {EDITOR_LIMITS.nodes}
            </span>
          </h2>
          <ul>
            {draft.nodes.map((node) => (
              <NodeEditor
                key={node.ref}
                node={node}
                draft={draft}
                open={openRef === node.ref}
                mapId={mapId}
                savedObjectives={savedObjectivesOf.get(node.ref)}
                disabled={saving}
                onToggle={() =>
                  setOpenRef((current) => (current === node.ref ? undefined : node.ref))
                }
                onChange={change}
                onObjectivesSaved={(objectives) =>
                  setSaved((current) => ({
                    ...current,
                    nodes: current.nodes.map((candidate) =>
                      candidate.kind === "own" && candidate.conceptId === node.ref
                        ? { ...candidate, objectives }
                        : candidate,
                    ),
                  }))
                }
              />
            ))}
          </ul>
          <button
            disabled={saving || draft.nodes.length >= EDITOR_LIMITS.nodes}
            onClick={() => {
              const added = addOwnNode(draft);
              change(added.draft);
              setOpenRef(added.ref);
            }}
          >
            + ノードを足す
          </button>
          <ReferencePicker
            candidates={candidates.filter((candidate) => !inDraft.has(candidate.id))}
            disabled={saving || draft.nodes.length >= EDITOR_LIMITS.nodes}
            onAdd={(candidate) => {
              change(addReference(draft, candidate.id, candidate.label));
              setOpenRef(candidate.id);
            }}
          />
        </div>
      </div>
      <div className="editor-save">
        {problems.length > 0 && (
          <ul className="editor-problems">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}
        {saveError && (
          <p className="error-text" role="alert">
            保存に失敗しました：{saveError}
          </p>
        )}
        {notice && !dirty && <p role="status">{notice}</p>}
        <button disabled={saving || !dirty || problems.length > 0} onClick={save}>
          {saving ? "保存中…" : "保存"}
        </button>
        {dirty && <span className="muted">保存していない変更があります。</span>}
      </div>
    </section>
  );
}

export const Route = createFileRoute("/_framed/maps/$mapId_/edit")({
  // 編集は保存済みの最新から始める。古い中身を下書きにしない。
  staleTime: 0,
  loader: async ({ params }) => {
    const retry = takeLoginRetry();
    const [map, own] = await Promise.all([
      fetchLearningMap(params.mapId, fetch, retry),
      fetchOwnMapConcepts(fetch, retry),
    ]);
    return { map, ownConcepts: own.concepts };
  },
  component: MapEditor,
});
