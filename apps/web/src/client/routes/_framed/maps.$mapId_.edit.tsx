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
  OWN_NODES_LIMIT,
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
  setPrerequisite,
  updateOwnNode,
  objectiveItemsFrom,
  objectiveProblems,
  objectivesChanged,
  removedObjectives,
  toObjectivesRequest,
  type DraftNode,
  type MapDraft,
  type ObjectiveItem,
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
 *
 * 下書きは画面（`MapEditor`）が持つ。ここに持つと、ノードを閉じたときに消え、
 * 画面を離れる前の確認にも入らない。
 */
function ObjectivesEditor({
  items,
  saved,
  saving,
  disabled,
  error,
  onChange,
  onSave,
}: {
  items: readonly ObjectiveItem[];
  saved: readonly LearningObjectiveView[];
  /** この項目を保存している最中。 */
  saving: boolean;
  /** ほかの書き込みの最中。書き込みは1つずつ行う。 */
  disabled: boolean;
  error: string | undefined;
  onChange: (items: ObjectiveItem[]) => void;
  onSave: () => void;
}) {
  const dirty = objectivesChanged(saved, items);
  const problems = objectiveProblems(items);
  const busy = saving || disabled;
  const setItems = (update: (current: readonly ObjectiveItem[]) => ObjectiveItem[]) =>
    onChange(update(items));

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
              disabled={busy}
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
              disabled={busy}
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
          disabled={busy || items.length >= EDITOR_LIMITS.objectives}
          onClick={() => setItems((current) => [...current, { label: "" }])}
        >
          + 項目を足す
        </button>
        <span className="muted">
          {items.length} / {EDITOR_LIMITS.objectives}
        </span>
        <button disabled={busy || !dirty || problems.length > 0} onClick={onSave}>
          {saving ? "保存中…" : "理解することを保存"}
        </button>
        {dirty && <span className="muted">保存していません。</span>}
      </div>
      {problems.map((problem) => (
        <p className="muted" key={problem}>
          {problem}
        </p>
      ))}
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
  objectives,
  disabled,
  onToggle,
  onChange,
}: {
  node: DraftNode;
  draft: MapDraft;
  open: boolean;
  /** 保存済みの手作りのノードの「理解すること」。新しいノード・参照のノードは `undefined`。 */
  objectives: Omit<Parameters<typeof ObjectivesEditor>[0], "disabled"> | undefined;
  /** 書き込みの最中。 */
  disabled: boolean;
  onToggle: () => void;
  onChange: (draft: MapDraft) => void;
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
          <label>
            前提（先に学ぶノード。1つまで）
            <select
              // 前提を複数持つ古い保存は、選び直すまで「選び直す」を出す。
              value={node.prerequisites.length === 1 ? node.prerequisites[0] : ""}
              disabled={disabled}
              onChange={(event) =>
                onChange(setPrerequisite(draft, node.ref, event.target.value || undefined))
              }
            >
              <option value="">
                {node.prerequisites.length > 1 ? "（1つ選び直す）" : "なし（最初に学ぶ）"}
              </option>
              {candidates.map((candidate) => (
                <option key={candidate.ref} value={candidate.ref}>
                  {nameOfRef(candidate.ref)}
                </option>
              ))}
            </select>
          </label>
          {node.prerequisites.length > 1 && (
            <p className="muted">
              前提が {node.prerequisites.length} 個あります（
              {node.prerequisites.map(nameOfRef).join("・")}）。1つ選び直してください。
            </p>
          )}
          {node.kind === "own" &&
            (objectives === undefined ? (
              <p className="muted">「理解すること」は、マップを保存すると書けるようになります。</p>
            ) : (
              <ObjectivesEditor {...objectives} disabled={disabled && !objectives.saving} />
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
  // 「理解すること」の下書き。直したノードの分だけ持つ（無ければ保存済みのまま）。
  const [objectiveDrafts, setObjectiveDrafts] = useState<Record<string, ObjectiveItem[]>>({});
  const [objectiveErrors, setObjectiveErrors] = useState<Record<string, string>>({});
  const [openRef, setOpenRef] = useState<string>();
  // 書き込みの最中のもの。マップ（"map"）か、項目を保存しているノードの ID。
  // 書き込みは1つずつ行う。マップの応答は項目を含むので、重なると古い項目で上書きしうる。
  const [writing, setWriting] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const guard = useRef(createSubmitGuard());
  const busy = writing !== undefined;

  const savedObjectivesOf = new Map(
    saved.nodes.flatMap((node) =>
      node.kind === "own" ? [[node.conceptId, node.objectives] as const] : [],
    ),
  );
  const objectiveItemsOf = (ref: string): ObjectiveItem[] =>
    objectiveDrafts[ref] ?? objectiveItemsFrom(savedObjectivesOf.get(ref) ?? []);
  // 下書きに残っているノードのうち、項目を直して保存していないもの。
  const unsavedObjectives = draft.nodes.filter((node) => {
    const savedObjectives = savedObjectivesOf.get(node.ref);
    const items = objectiveDrafts[node.ref];
    return savedObjectives !== undefined && items !== undefined
      ? objectivesChanged(savedObjectives, items)
      : false;
  });

  const dirty = isDirty(saved, draft);
  const problems = draftProblems(draft);
  const unsaved = dirty || unsavedObjectives.length > 0;
  // 保存していない変更（ノード・線・項目）があるまま画面を離れない。
  useBlocker({
    shouldBlockFn: () => !window.confirm("保存していない変更があります。破棄して離れますか？"),
    enableBeforeUnload: unsaved,
    disabled: !unsaved,
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

  const change = (next: MapDraft) => {
    setNotice(undefined);
    setDraft(next);
  };

  /**
   * 書き込みを1つずつ行う。最中なら何もしない（RULE-007）。
   * セッション切れはログインへ送る。それ以外の失敗は `task` が画面に出す。
   */
  const write = (key: string, task: () => Promise<void>) => {
    if (guard.current.isRunning("write")) return;
    setWriting(key);
    void guard.current
      .run("write", async () => {
        try {
          await task();
        } catch (value: unknown) {
          if (value instanceof ApiError && value.kind === "session_expired") {
            window.location.href = "/login";
            return;
          }
          throw value;
        }
      })
      .finally(() => setWriting(undefined));
  };

  const save = () => {
    if (problems.length > 0) return;
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
    write("map", async () => {
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
        if (value instanceof ApiError && value.kind === "session_expired") throw value;
        setSaveError(saveErrorText(value));
      }
    });
  };

  const saveObjectivesOf = (ref: string) => {
    const savedObjectives = savedObjectivesOf.get(ref) ?? [];
    const items = objectiveItemsOf(ref);
    if (objectiveProblems(items).length > 0) return;
    const removed = removedObjectives(savedObjectives, items);
    if (
      removed.length > 0 &&
      !window.confirm(
        `${removed.map((objective) => objective.label).join("・")} を消します。` +
          "その項目を狙って作った確認問題も消えます。",
      )
    )
      return;
    setObjectiveErrors((current) => withoutKey(current, ref));
    write(ref, async () => {
      try {
        const result = await saveObjectives(mapId, ref, toObjectivesRequest(items));
        setSaved((current) => ({
          ...current,
          nodes: current.nodes.map((node) =>
            node.kind === "own" && node.conceptId === ref
              ? { ...node, objectives: result.objectives }
              : node,
          ),
        }));
        setObjectiveDrafts((current) => withoutKey(current, ref));
      } catch (value: unknown) {
        if (value instanceof ApiError && value.kind === "session_expired") throw value;
        setObjectiveErrors((current) => ({ ...current, [ref]: saveErrorText(value) }));
      }
    });
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
            disabled={busy}
            onChange={(event) => change({ ...draft, title: event.target.value })}
          />
        </label>
        <label>
          説明（任意）
          <textarea
            value={draft.description}
            maxLength={EDITOR_LIMITS.description}
            rows={2}
            disabled={busy}
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
            {draft.nodes.map((node) => {
              const savedObjectives =
                node.kind === "own" ? savedObjectivesOf.get(node.ref) : undefined;
              return (
                <NodeEditor
                  key={node.ref}
                  node={node}
                  draft={draft}
                  open={openRef === node.ref}
                  objectives={
                    savedObjectives === undefined
                      ? undefined
                      : {
                          items: objectiveItemsOf(node.ref),
                          saved: savedObjectives,
                          saving: writing === node.ref,
                          error: objectiveErrors[node.ref],
                          onChange: (items) =>
                            setObjectiveDrafts((current) => ({ ...current, [node.ref]: items })),
                          onSave: () => saveObjectivesOf(node.ref),
                        }
                  }
                  disabled={busy}
                  onToggle={() =>
                    setOpenRef((current) => (current === node.ref ? undefined : node.ref))
                  }
                  onChange={change}
                />
              );
            })}
          </ul>
          <button
            disabled={busy || draft.nodes.length >= EDITOR_LIMITS.nodes}
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
            disabled={busy || draft.nodes.length >= EDITOR_LIMITS.nodes}
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
        <button disabled={busy || !dirty || problems.length > 0} onClick={save}>
          {writing === "map" ? "保存中…" : "保存"}
        </button>
        {dirty && <span className="muted">保存していない変更があります。</span>}
        {unsavedObjectives.length > 0 && (
          <span className="muted">
            「理解すること」を保存していないノード：
            {unsavedObjectives.map((node) => node.label.trim() || "（無題）").join("・")}
          </span>
        )}
      </div>
    </section>
  );
}

/** `key` を除いた複製。 */
function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const rest = { ...record };
  delete rest[key];
  return rest;
}

export const Route = createFileRoute("/_framed/maps/$mapId_/edit")({
  // 編集は保存済みの最新から始める。古い中身を下書きにしない。
  staleTime: 0,
  loader: async ({ params }) => {
    const retry = takeLoginRetry();
    const [map, own] = await Promise.all([
      fetchLearningMap(params.mapId, fetch, retry),
      // 参照で足す候補。VS Code 向けの既定（100 件）ではなく、自分のノードを全部読む。
      fetchOwnMapConcepts(fetch, retry, OWN_NODES_LIMIT),
    ]);
    return { map, ownConcepts: own.concepts };
  },
  // 下書きはマップごと。同じ画面のまま別のマップへ移ったとき、前のマップの下書きで
  // 移った先を保存しないよう、作り直す。
  component: function MapEditorForMap() {
    const { mapId } = Route.useParams();
    return <MapEditor key={mapId} />;
  },
});
