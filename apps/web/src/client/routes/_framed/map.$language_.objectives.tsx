import { createFileRoute, Link, useBlocker, useRouter } from "@tanstack/react-router";
import { CONCEPTS, type Concept } from "@gakushu-sochi/domain";
import { useRef, useState } from "react";
import { ApiError, createSubmitGuard } from "../../api.js";
import { toErrorText } from "../../errors.js";
import {
  fetchFixedMaps,
  FIXED_OBJECTIVE_LIMITS,
  FixedObjectivesError,
  generateFixedObjectives,
  itemProblems,
  itemsChanged,
  itemsFromDraft,
  itemsFromSaved,
  reassign,
  relabel,
  removedOnSave,
  saveFixedObjectives,
  type FixedObjectiveItem,
  type FixedObjectiveView,
} from "../../fixed-maps.js";
import { languageLabel } from "../../learning-map-view.js";
import { takeLoginRetry } from "../../session.js";

/** 失敗を、作成者が何をすればよいか分かる文面にする（RULE-004）。 */
function errorText(error: unknown): string {
  if (error instanceof FixedObjectivesError) return error.detail;
  return toErrorText(error);
}

/**
 * 1つの Concept の項目。今の項目（保存済み）と、編集中の項目を並べる。
 *
 * 項目ごとに「どの今の項目を引き継ぐか」を選べる。AI の案の対応が違うとき、作成者がここで付け替える
 * （#245 の決定 N6）。引き継いだ項目は ID が変わらないので、その項目の理解度が残る。
 */
function ConceptObjectivesEditor({
  concept,
  saved,
  items,
  dirty,
  busy,
  saving,
  generating,
  error,
  onChange,
  onReset,
  onGenerate,
  onSave,
}: {
  concept: Concept;
  saved: readonly FixedObjectiveView[];
  items: readonly FixedObjectiveItem[];
  dirty: boolean;
  /** ほかの書き込みの最中。書き込みは1つずつ行う。 */
  busy: boolean;
  saving: boolean;
  generating: boolean;
  error: string | undefined;
  onChange: (items: FixedObjectiveItem[]) => void;
  onReset: () => void;
  onGenerate: () => void;
  onSave: () => void;
}) {
  const problems = itemProblems(items);
  const removed = removedOnSave(saved, items);
  const update = (index: number, next: FixedObjectiveItem) =>
    onChange(items.map((item, at) => (at === index ? next : item)));

  return (
    <fieldset className="editor-objectives fixed-objectives">
      <legend>{concept.label}</legend>
      {concept.summary && <p className="muted">{concept.summary}</p>}
      <ol>
        {items.map((item, index) => (
          <li key={`${String(index)}-${item.id ?? "new"}`}>
            <input
              value={item.label}
              maxLength={FIXED_OBJECTIVE_LIMITS.label}
              aria-label={`${concept.label} の理解すること ${String(index + 1)}`}
              disabled={busy}
              onChange={(event) => update(index, relabel(item, event.target.value))}
            />
            <select
              value={item.id ?? ""}
              aria-label={`${concept.label} の理解すること ${String(index + 1)} が引き継ぐ今の項目`}
              disabled={busy}
              onChange={(event) => update(index, reassign(item, event.target.value || undefined))}
            >
              <option value="">新しい項目</option>
              {saved.map((objective) => (
                <option key={objective.id} value={objective.id}>
                  引き継ぐ：{objective.label}
                </option>
              ))}
            </select>
            {item.fromAi && <em className="badge">AI</em>}
            {item.previousLabel !== undefined && (
              <span className="muted">（前：{item.previousLabel}）</span>
            )}
            <button
              className="link"
              disabled={busy}
              onClick={() => onChange(items.filter((_, at) => at !== index))}
            >
              外す
            </button>
          </li>
        ))}
      </ol>
      <div className="editor-row">
        <button
          className="link"
          disabled={busy || items.length >= FIXED_OBJECTIVE_LIMITS.objectives}
          onClick={() => onChange([...items, { label: "", fromAi: false }])}
        >
          + 項目を足す
        </button>
        <span className="muted">
          {items.length} / {FIXED_OBJECTIVE_LIMITS.objectives}
        </span>
        <button className="link" disabled={busy} onClick={onGenerate}>
          {generating ? "作り直し中…" : "AI で作り直す"}
        </button>
        <button className="link" disabled={busy || !dirty} onClick={onReset}>
          今の項目に戻す
        </button>
        <button disabled={busy || !dirty || problems.length > 0} onClick={onSave}>
          {saving ? "確定中…" : "確定"}
        </button>
        {dirty && <span className="muted">確定していません。</span>}
      </div>
      {dirty && removed.length > 0 && (
        <p className="muted">
          確定すると消える項目：{removed.map((objective) => objective.label).join("・")}
        </p>
      )}
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

/**
 * 言語別マップの「理解すること」の編集（#245）。その言語のマップの作成者だけが使える。
 *
 * AI の作り直しは案を返すだけで保存しない。作成者が差分を確かめ、どの今の項目に当たるかを直してから、
 * Concept ごとに「確定」する。確定は全利用者の理解度と確認問題に効く。
 */
function FixedObjectivesEditor() {
  const { language } = Route.useParams();
  const loaded = Route.useLoaderData();
  const router = useRouter();
  const concepts = CONCEPTS.filter((concept) => concept.language === language);
  const [saved, setSaved] = useState<ReadonlyMap<string, FixedObjectiveView[]>>(() => {
    const grouped = new Map<string, FixedObjectiveView[]>();
    for (const objective of loaded.objectives) {
      grouped.set(objective.conceptId, [...(grouped.get(objective.conceptId) ?? []), objective]);
    }
    return grouped;
  });
  // 直した Concept の分だけ持つ（無ければ保存済みのまま）。
  const [drafts, setDrafts] = useState<Record<string, FixedObjectiveItem[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  // 書き込みの最中のもの。全部の作り直し（"all"）か、作り直し・確定している Concept の ID。
  const [writing, setWriting] = useState<{ key: string; kind: "generate" | "save" }>();
  const [notice, setNotice] = useState<string>();
  const [generateError, setGenerateError] = useState<string>();
  const guard = useRef(createSubmitGuard());
  const busy = writing !== undefined;

  const savedOf = (conceptId: string) => saved.get(conceptId) ?? [];
  const itemsOf = (conceptId: string) => drafts[conceptId] ?? itemsFromSaved(savedOf(conceptId));
  const dirtyOf = (conceptId: string) =>
    drafts[conceptId] !== undefined && itemsChanged(savedOf(conceptId), drafts[conceptId]);
  const unsaved = concepts.filter((concept) => dirtyOf(concept.id));

  // 確定していない案があるまま画面を離れない。AI の案は保存していないので、離れると消える。
  useBlocker({
    shouldBlockFn: () => !window.confirm("確定していない変更があります。破棄して離れますか？"),
    enableBeforeUnload: unsaved.length > 0,
    disabled: unsaved.length === 0,
  });

  if (!loaded.editableLanguages.includes(language) || concepts.length === 0) {
    return (
      <section className="message">
        <p>
          {concepts.length === 0
            ? `「${language}」という領域はありません。`
            : "この言語のマップの「理解すること」は、マップの作成者だけが編集できます。"}
        </p>
        <Link to="/">項目一覧へ戻る</Link>
      </section>
    );
  }

  /**
   * 書き込みを1つずつ行う。最中なら何もしない（RULE-007）。
   * セッション切れはログインへ送る。それ以外の失敗は `task` が画面に出す。
   */
  const write = (key: string, kind: "generate" | "save", task: () => Promise<void>) => {
    if (guard.current.isRunning("write")) return;
    setWriting({ key, kind });
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

  /** AI で作り直す。`conceptIds` を省くと全部。案は下書きに入れ、保存はしない。 */
  const generate = (conceptIds: readonly string[] | undefined) => {
    const targets = conceptIds ?? concepts.map((concept) => concept.id);
    const overwritten = targets.filter((conceptId) => dirtyOf(conceptId));
    if (
      overwritten.length > 0 &&
      !window.confirm("確定していない変更を、AI の案で置き換えます。よろしいですか？")
    )
      return;
    setNotice(undefined);
    setGenerateError(undefined);
    setErrors((current) => withoutKeys(current, targets));
    const key = conceptIds === undefined ? "all" : targets[0]!;
    write(key, "generate", async () => {
      try {
        const result = await generateFixedObjectives(language, conceptIds);
        setDrafts((current) => ({
          ...current,
          ...Object.fromEntries(
            result.map((draft) => [draft.conceptId, itemsFromDraft(draft)] as const),
          ),
        }));
        setNotice("AI の案を入れました。確かめてから、Concept ごとに確定してください。");
      } catch (value: unknown) {
        if (value instanceof ApiError && value.kind === "session_expired") throw value;
        if (conceptIds === undefined) setGenerateError(errorText(value));
        else setErrors((current) => ({ ...current, [key]: errorText(value) }));
      }
    });
  };

  const save = (concept: Concept) => {
    const items = itemsOf(concept.id);
    if (itemProblems(items).length > 0) return;
    const removed = removedOnSave(savedOf(concept.id), items);
    if (
      removed.length > 0 &&
      !window.confirm(
        `${removed.map((objective) => objective.label).join("・")} を消します。` +
          "その項目を狙って作った確認問題は、すべての利用者の分が消えます。学習の記録は残ります。",
      )
    )
      return;
    setNotice(undefined);
    setErrors((current) => withoutKeys(current, [concept.id]));
    write(concept.id, "save", async () => {
      try {
        const result = await saveFixedObjectives(language, concept.id, items);
        setSaved((current) => new Map(current).set(concept.id, result));
        setDrafts((current) => withoutKeys(current, [concept.id]));
        setNotice(`${concept.label} の項目を確定しました。`);
        // 地図・項目一覧の loader を捨て、戻ったときに古い項目を見せない（RULE-005）。
        await router.invalidate();
      } catch (value: unknown) {
        if (value instanceof ApiError && value.kind === "session_expired") throw value;
        setErrors((current) => ({ ...current, [concept.id]: errorText(value) }));
      }
    });
  };

  const name = languageLabel[language] ?? language;
  return (
    <section className="editor">
      <p className="map-head">
        <Link to="/map/$language" params={{ language }} className="link">
          ← マップへ戻る
        </Link>
        <h1>{name} の理解すること</h1>
      </p>
      <div className="editor-meta">
        <p className="muted">
          この言語のマップの作成者だけが編集できます。確定した項目は、すべての利用者の理解度と確認問題に使われます。
          「AI
          で作り直す」は案を作るだけで保存しません。今の項目と同じ内容なら引き継ぎ（理解度が残ります）、
          違えば新しい項目になります。対応が違うときは、項目の右の欄で付け替えてください。
          作り直しは AI の利用回数を使います。
        </p>
        <div className="editor-row">
          <button disabled={busy} onClick={() => generate(undefined)}>
            {writing?.key === "all" ? "作り直し中…" : `${name} の全 Concept を AI で作り直す`}
          </button>
          {unsaved.length > 0 && (
            <span className="muted">
              確定していない Concept：{unsaved.map((concept) => concept.label).join("・")}
            </span>
          )}
        </div>
        {generateError && (
          <p className="error-text" role="alert">
            作り直しに失敗しました：{generateError}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
      </div>
      {concepts.map((concept) => (
        <ConceptObjectivesEditor
          key={concept.id}
          concept={concept}
          saved={savedOf(concept.id)}
          items={itemsOf(concept.id)}
          dirty={dirtyOf(concept.id)}
          busy={busy}
          saving={writing?.key === concept.id && writing.kind === "save"}
          generating={
            writing?.kind === "generate" && (writing.key === "all" || writing.key === concept.id)
          }
          error={errors[concept.id]}
          onChange={(items) => {
            setNotice(undefined);
            setDrafts((current) => ({ ...current, [concept.id]: items }));
          }}
          onReset={() => setDrafts((current) => withoutKeys(current, [concept.id]))}
          onGenerate={() => generate([concept.id])}
          onSave={() => save(concept)}
        />
      ))}
    </section>
  );
}

/** `keys` を除いた複製。 */
function withoutKeys<T>(record: Record<string, T>, keys: readonly string[]): Record<string, T> {
  const rest = { ...record };
  for (const key of keys) delete rest[key];
  return rest;
}

export const Route = createFileRoute("/_framed/map/$language_/objectives")({
  // 編集は保存済みの最新から始める。古い中身を下書きにしない。
  staleTime: 0,
  loader: () => fetchFixedMaps(fetch, takeLoginRetry()),
  // 下書きは言語ごと。同じ画面のまま別の言語へ移ったとき、前の言語の下書きを持ち越さない。
  component: function FixedObjectivesEditorForLanguage() {
    const { language } = Route.useParams();
    return <FixedObjectivesEditor key={language} />;
  },
});
