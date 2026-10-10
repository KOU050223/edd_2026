import { toErrorText } from "./errors.js";
import { HistoryQuestionBrowser } from "./history-question-browser.js";
import { historyProgressSummary } from "./history-presentation.js";
import { Link, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ApiError, createSubmitGuard, deleteJson, postJsonBody, requestJson } from "./api.js";
import type { LearningEvidence } from "@gakushu-sochi/domain";
import { fetchAiUsage, type AiUsageSummary } from "./ai-usage.js";
import { remainingRequests } from "./map-generation.js";
import { historyUserId, openHistoryStore } from "./history-store.js";
import {
  filterHistory,
  historyQuestions,
  historyQuestionCount,
  type HistoryQuestion,
} from "./local-history.js";
import {
  analyzeHistoryBatch,
  fetchHistoryTarget,
  historyEvidence,
  localHistoryMatch,
  localHistoryNameMatch,
  pendingHistory,
  previewHistory,
  reconcileHistoryProgress,
  selectHistoryBatch,
  HISTORY_ANALYSIS_VERSION,
  HISTORY_CALL_LIMIT,
  type HistoryProgress,
  type HistoryTarget,
} from "./history-analysis.js";

export function HistoryMapPanel({
  target,
  onApplied,
}: {
  target: string;
  onApplied?: (conceptId: string) => void | Promise<void>;
}) {
  const router = useRouter();
  const guard = useRef(createSubmitGuard());
  const mounted = useRef(true);
  const cancel = useRef(false);
  const [running, setRunning] = useState(false);
  const [opened, setOpened] = useState(false);
  const [data, setData] = useState<{
    userId: string;
    questions: HistoryQuestion[];
    target: HistoryTarget;
    usage: AiUsageSummary;
  }>();
  const [project, setProject] = useState("");
  const from = "";
  const to = "";
  const [consent, setConsent] = useState(false);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [progress, setProgress] = useState<HistoryProgress>();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancel.current = true;
    };
  }, []);
  const run = (operation: () => Promise<void>) => {
    if (guard.current.isRunning("history")) return;
    cancel.current = false;
    setRunning(true);
    setError("");
    void guard.current.run("history", async () => {
      try {
        await operation();
      } catch (value) {
        if (mounted.current)
          setError(
            value instanceof ApiError
              ? value.kind === "rate_limited"
                ? "AI の利用枠または要求回数の上限に達しました。保存済みの結果は適用でき、未解析分は後から再開できます"
                : toErrorText(value)
              : value instanceof Error
                ? value.message
                : String(value),
          );
      } finally {
        if (mounted.current) setRunning(false);
      }
    });
  };
  const open = () =>
    run(async () => {
      const userId = await historyUserId();
      const store = await openHistoryStore(userId);
      try {
        const [files, definition, usage] = await Promise.all([
          store.files(),
          fetchHistoryTarget(target),
          fetchAiUsage(fetch, 0),
        ]);
        const questions = historyQuestions(files);
        const saved = await store.loadProgress<HistoryProgress>(
          JSON.stringify([target, project, "", ""]),
        );
        if (mounted.current) {
          setData({ userId, questions, target: definition, usage });
          setProgress(
            saved
              ? reconcileHistoryProgress(
                  saved,
                  filterHistory(questions, project, "", ""),
                  definition,
                )
              : undefined,
          );
          setExcluded(saved?.excludedConceptIds ?? []);
          setOpened(true);
        }
      } finally {
        store.close();
      }
    });
  const selection = data ? filterHistory(data.questions, project, from, to) : [];
  const selectionKey = JSON.stringify([target, project, from, to]);
  const analyze = () =>
    run(async () => {
      if (!data) return;
      if ((await historyUserId()) !== data.userId)
        throw new Error("アカウントが変わりました。画面を開き直してください");
      const store = await openHistoryStore(data.userId);
      try {
        const [definition, files, usage] = await Promise.all([
          fetchHistoryTarget(target),
          store.files(),
          fetchAiUsage(fetch, 0),
        ]);
        const questions = filterHistory(historyQuestions(files), project, from, to);
        let current = reconcileHistoryProgress(
          (await store.loadProgress<HistoryProgress>(selectionKey)) ?? {
            key: selectionKey,
            version: HISTORY_ANALYSIS_VERSION,
            classifications: [],
            applications: [],
          },
          questions,
          definition,
        );
        if (current.pendingApplication)
          throw new Error("前回の反映の応答を確認できていません。「反映を再確認」を押してください");
        const save = async () => {
          await store.saveProgress(current);
          if (mounted.current) {
            setExcluded(current.excludedConceptIds ?? []);
            setProgress({ ...current, classifications: [...current.classifications] });
          }
        };
        if (mounted.current)
          setData({ ...data, questions: historyQuestions(files), target: definition, usage });
        for (const item of pendingHistory(questions, definition, current)) {
          for (const concept of item.concepts)
            if (
              localHistoryMatch(item.question, concept) ||
              localHistoryNameMatch(item.question, concept, definition)
            )
              current.classifications.push({
                question: item.question.key,
                inputFingerprint: item.question.fingerprint,
                concept: concept.id,
                definitionFingerprint: concept.fingerprint,
                confidence: localHistoryMatch(item.question, concept) ? 1 : 0.8,
              });
        }
        await save();
        const calls = Math.min(HISTORY_CALL_LIMIT, remainingRequests(usage));
        let used = 0;
        while (!cancel.current && mounted.current) {
          const pending = pendingHistory(questions, definition, current);
          if (!pending.length) break;
          if (!consent || used >= calls) break;
          // Small bounded candidate batches. Only the current map's unresolved definitions are sent.
          const { concepts, questions: batch } = selectHistoryBatch(pending, definition);
          setMessage(`関連する概念を探しています… ${used + 1} / ${calls} 回`);
          const result = await analyzeHistoryBatch(batch, concepts, target);
          current = { ...current, classifications: [...current.classifications, ...result] };
          used++;
          await save();
        }
        if (mounted.current)
          setMessage(
            cancel.current
              ? "中断しました。見つかった概念は下で確認して反映できます。"
              : !consent
                ? "名前が一致する概念を確認しました。AI を使うと、言い換えや文脈からも関連を探せます。"
                : pendingHistory(questions, definition, current).length
                  ? "見つかった概念を確認してください。残りの質問は「続きを解析」で調べられます。"
                  : "すべての質問を確認しました。関連する概念を選んでマップに反映してください。",
          );
      } finally {
        store.close();
      }
    });
  const refresh = () =>
    run(async () => {
      if (!data) return;
      if ((await historyUserId()) !== data.userId) throw new Error("アカウントが変わりました");
      const store = await openHistoryStore(data.userId);
      try {
        const saved = await store.loadProgress<HistoryProgress>(selectionKey);
        const definition = await fetchHistoryTarget(target);
        const questions = historyQuestions(await store.files());
        if (mounted.current) {
          setData({ ...data, questions, target: definition });
          setExcluded(saved?.excludedConceptIds ?? []);
          setProgress(
            saved
              ? reconcileHistoryProgress(
                  saved,
                  filterHistory(questions, project, from, to),
                  definition,
                )
              : undefined,
          );
        }
      } finally {
        store.close();
      }
    });
  const apply = () =>
    run(async () => {
      if (!data || !progress) return;
      if ((await historyUserId()) !== data.userId) throw new Error("アカウントが変わりました");
      const store = await openHistoryStore(data.userId);
      try {
        let existing = new Set<string>();
        if (!progress.pendingApplication) {
          const [files, definition, savedEvidence] = await Promise.all([
            store.files(),
            fetchHistoryTarget(target),
            requestJson<{ evidence: LearningEvidence[] }>("/api/v1/learning-evidence"),
          ]);
          existing = new Set(
            savedEvidence.evidence.flatMap((item) =>
              item.observationKey === undefined
                ? []
                : item.conceptIds.map((id) => `${item.observationKey}:${id}`),
            ),
          );
          const latest = reconcileHistoryProgress(
            progress,
            filterHistory(historyQuestions(files), project, from, to),
            definition,
          );
          if (latest.classifications.length !== progress.classifications.length) {
            throw new Error(
              "履歴またはマップが変更されました。保存済み進捗を読み直し、変更分を解析してください",
            );
          }
        }
        const rows = previewHistory(selection, data.target, progress).filter(
          (row) => !excluded.includes(row.concept.id),
        );
        const pending = progress.pendingApplication ?? {
          id: crypto.randomUUID(),
          evidence: [],
          fingerprints: Object.fromEntries(
            rows.map((row) => [row.concept.id, row.concept.fingerprint]),
          ),
        };
        if (!progress.pendingApplication) {
          pending.evidence = historyEvidence(
            pending.id,
            selection,
            rows.flatMap((row) => row.matches),
          )
            .filter((item) => !existing.has(`${item.observationKey}:${item.conceptIds[0]}`))
            .slice(0, 5_000);
          pending.fingerprints = Object.fromEntries(
            pending.evidence.map((item) => [
              item.conceptIds[0]!,
              pending.fingerprints[item.conceptIds[0]!]!,
            ]),
          );
        }
        if (!pending.evidence.length)
          throw new Error("追加する観測がありません。すでに反映済みか、すべて除外されています");
        // Persist the exact request ID before sending. A lost response can be retried safely.
        const applying = { ...progress, pendingApplication: pending };
        await store.saveProgress(applying);
        setProgress(applying);
        const saved = await postJsonBody<{ id: string; evidenceCount: number }>(
          "/api/v1/import-sessions",
          {
            id: pending.id,
            importedBy: "file",
            providers: ["claude-code"],
            conversationCount: historyQuestionCount(selection),
            mapTarget: { target, fingerprints: pending.fingerprints },
            evidence: pending.evidence,
          },
        );
        if (saved.id !== pending.id || !Number.isInteger(saved.evidenceCount))
          throw new Error("適用応答が不正です。同じ適用を再送できます");
        const next = {
          ...progress,
          applications: [
            ...progress.applications,
            { id: pending.id, concepts: Object.keys(pending.fingerprints) },
          ],
          pendingApplication: undefined,
        };
        await store.saveProgress(next);
        if (mounted.current) setProgress(next);
        await router.invalidate();
        const profile = await requestJson<{
          familiarity?: { conceptId: string; observationCount: number }[];
        }>("/api/v1/learning-profile");
        const appliedIds = Object.keys(pending.fingerprints);
        if (
          !appliedIds.every((id) =>
            profile.familiarity?.some((item) => item.conceptId === id && item.observationCount > 0),
          )
        )
          throw new Error(
            "質問は保存されましたが、マップの履歴表示を確認できませんでした。ページを再読み込みしてください。反映し直す必要はありません。",
          );
        if (mounted.current) {
          setProgress(next);
          setExcluded(next.excludedConceptIds ?? []);
          setMessage(
            `${appliedIds.length} 個の概念に質問 ${saved.evidenceCount} 件を反映しました。マップの「履歴あり」に表示されます。`,
          );
          if (appliedIds[0]) await onApplied?.(appliedIds[0]);
          document
            .getElementById("learning-map")
            ?.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      } finally {
        store.close();
      }
    });
  const rebuild = () =>
    run(async () => {
      if (!data || !progress?.pendingApplication) return;
      if ((await historyUserId()) !== data.userId) throw new Error("アカウントが変わりました");
      const store = await openHistoryStore(data.userId);
      try {
        const pending = progress.pendingApplication;
        let committed = false;
        try {
          await requestJson(`/api/v1/import-sessions/${encodeURIComponent(pending.id)}`);
          committed = true;
        } catch (value) {
          if (!(value instanceof ApiError && value.kind === "not_found")) throw value;
        }
        const [files, definition] = await Promise.all([store.files(), fetchHistoryTarget(target)]);
        const questions = historyQuestions(files);
        const next = reconcileHistoryProgress(
          {
            ...progress,
            pendingApplication: undefined,
            applications: committed
              ? [
                  ...progress.applications,
                  { id: pending.id, concepts: Object.keys(pending.fingerprints) },
                ]
              : progress.applications,
          },
          filterHistory(questions, project, from, to),
          definition,
        );
        await store.saveProgress(next);
        if (mounted.current) {
          setData({ ...data, questions, target: definition });
          setProgress(next);
          setMessage(
            committed
              ? "反映済みの結果を照合しました。既存の観測は残しています"
              : "未保存の適用を解除しました。変更分を解析してプレビューを作り直してください",
          );
        }
      } finally {
        store.close();
      }
    });
  const changeProject = (name: string) =>
    run(async () => {
      if (!data) return;
      if ((await historyUserId()) !== data.userId)
        throw new Error("ログイン中のユーザーが変わりました");
      const store = await openHistoryStore(data.userId);
      try {
        const saved = await store.loadProgress<HistoryProgress>(
          JSON.stringify([target, name, "", ""]),
        );
        if (mounted.current) {
          setProject(name);
          setProgress(
            saved
              ? reconcileHistoryProgress(
                  saved,
                  filterHistory(data.questions, name, "", ""),
                  data.target,
                )
              : undefined,
          );
          setExcluded(saved?.excludedConceptIds ?? []);
          setMessage("");
        }
      } finally {
        store.close();
      }
    });
  const toggleConcept = (id: string, checked: boolean) =>
    run(async () => {
      if (!data || !progress) return;
      if ((await historyUserId()) !== data.userId)
        throw new Error("ログイン中のユーザーが変わりました");
      const nextExcluded = checked ? excluded.filter((value) => value !== id) : [...excluded, id];
      const next = { ...progress, excludedConceptIds: nextExcluded };
      const store = await openHistoryStore(data.userId);
      try {
        await store.saveProgress(next);
        if (mounted.current) {
          setProgress(next);
          setExcluded(nextExcluded);
        }
      } finally {
        store.close();
      }
    });
  if (!opened)
    return (
      <section className="message history-panel">
        <h2>Claude Code の質問をマップへ反映</h2>
        <p>取り込んだ質問を確認し、このマップの概念に関連する質問を反映できます。</p>
        <div className="actions">
          <button disabled={running} onClick={open}>
            {running ? "質問を読み込み中" : "取り込んだ質問を確認する"}
          </button>
          <Link to="/local-history">履歴を取り込む</Link>
        </div>
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
      </section>
    );
  const preview = data && progress ? previewHistory(selection, data.target, progress) : [];
  const counts = data
    ? historyProgressSummary(selection, data.target, progress)
    : { total: 0, related: 0, unrelated: 0, pending: 0 };
  const selectedCount = preview.filter((row) => !excluded.includes(row.concept.id)).length;
  return (
    <section className="message history-panel">
      <div className="history-section-head">
        <h2>質問からマップへ</h2>
        <Link to="/local-history">履歴管理</Link>
      </div>
      <ol className="history-steps" aria-label="反映の手順">
        <li>質問を確認</li>
        <li>関連する概念を探す</li>
        <li>マップに反映</li>
      </ol>
      <label className="history-search">
        質問のプロジェクト
        <select
          disabled={running || !!progress?.pendingApplication}
          value={project}
          onChange={(event) => changeProject(event.target.value)}
        >
          <option value="">すべてのプロジェクト</option>
          {[...new Set(data?.questions.map((question) => question.project))].map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
      </label>
      <div className="history-stats history-map-stats" role="status">
        <div className="history-stat-total">
          <strong>{counts.total}</strong>取り込んだ質問
        </div>
        <div className="history-stat-related">
          <strong>{counts.related}</strong>関連が見つかった質問
        </div>
        <div className="history-stat-pending">
          <strong>{counts.pending}</strong>関連が未確認の質問
        </div>
        <div className="history-stat-unrelated">
          <strong>{counts.unrelated}</strong>このマップに関連なし
        </div>
      </div>
      {!selection.length ? (
        <p>
          質問がありません。<Link to="/local-history">履歴管理でフォルダを選んでください</Link>
        </p>
      ) : (
        <>
          <HistoryQuestionBrowser
            key={project}
            questions={selection}
            title="1. 取り込んだ質問を確認"
          />
          <h3>2. 関連する概念を探す</h3>
          <p>
            まず質問に含まれる概念名を照合します。AI
            を使うと、名前が一致しない質問も内容から分類できます。確認した結果は自動保存され、続きから解析できます。
          </p>
          <div className="history-consent">
            <label>
              <input
                type="checkbox"
                disabled={running}
                checked={consent}
                onChange={(event) => setConsent(event.target.checked)}
              />{" "}
              質問を AI に送信し、関連する概念を探すことに同意する
            </label>
            <p>
              マスク済みの質問とこのマップの概念定義を Google Gemini に送ります。AI
              の回答は送りません。会話全文はサーバーに保存しません。1回の操作で最大{" "}
              {HISTORY_CALL_LIMIT} 回呼び出します。残りの利用枠は{" "}
              {data ? remainingRequests(data.usage) : 0} 回です。
            </p>
          </div>
          <div className="actions">
            <button
              disabled={running || !!progress?.pendingApplication || !data?.target.concepts.length}
              onClick={analyze}
            >
              {running
                ? "確認中"
                : !consent
                  ? "名前が一致する概念を探す"
                  : progress?.classifications.length
                    ? "続きを解析する"
                    : "AI で関連する概念を探す"}
            </button>
            {running && (
              <button
                className="secondary"
                onClick={() => {
                  cancel.current = true;
                }}
              >
                この呼び出し後に中断
              </button>
            )}
            <button
              className="secondary"
              disabled={running || !!progress?.pendingApplication}
              onClick={refresh}
            >
              取り込み済みの質問を更新
            </button>
          </div>
          {!consent && !preview.length && (
            <p className="hint">
              概念名が質問にない場合は、AI による分類で関連する概念を探せます。
            </p>
          )}
          <h3>3. マップに反映する概念を選ぶ</h3>
          {!preview.length && (
            <p className="history-empty">
              反映候補はまだありません。上の「関連する概念を探す」を実行してください。別のマップに関連する質問はこのマップには表示されません。
            </p>
          )}
          <div className="history-concept-list">
            {preview.map((row) => {
              const matchedKeys = new Set(row.matches.map((match) => match.question));
              const parentKeys = new Set(
                selection
                  .filter((question) => matchedKeys.has(question.key))
                  .map((question) => question.observationKey ?? question.key),
              );
              return (
                <article
                  className={
                    excluded.includes(row.concept.id)
                      ? "history-concept excluded"
                      : "history-concept"
                  }
                  key={row.concept.id}
                >
                  <label>
                    <input
                      type="checkbox"
                      checked={!excluded.includes(row.concept.id)}
                      disabled={running || !!progress?.pendingApplication}
                      onChange={(event) => toggleConcept(row.concept.id, event.target.checked)}
                    />
                    <strong>{row.concept.label}</strong>
                    <span>{row.count} 件の質問</span>
                  </label>
                  <p className="muted">{row.concept.summary}</p>
                  <details>
                    <summary>関連する質問を確認</summary>
                    <HistoryQuestionBrowser
                      questions={selection.filter((question) =>
                        parentKeys.has(question.observationKey ?? question.key),
                      )}
                      title={row.concept.label + " に関連する質問"}
                    />
                  </details>
                </article>
              );
            })}
          </div>
          <p>
            反映すると、該当する概念に「履歴あり」と質問件数が表示されます。理解度は上がりません。1回に最大5000観測を反映できます。残りがある場合はもう一度反映してください。
          </p>
          <div className="actions">
            <button
              disabled={running || (!selectedCount && !progress?.pendingApplication)}
              onClick={apply}
            >
              {progress?.pendingApplication
                ? "反映を再確認"
                : selectedCount + " 個の概念をマップに反映"}
            </button>
            <a href="#learning-map">マップを見る</a>
          </div>
          {progress?.pendingApplication && (
            <button disabled={running} onClick={rebuild}>
              未反映の候補からやり直す
            </button>
          )}
        </>
      )}
      {data?.target.warnings.map((warning) => (
        <p key={warning} role="alert">
          {warning}
        </p>
      ))}
      {message && (
        <p className="history-result" role="status">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {!!progress?.applications.length && (
        <details>
          <summary>これまでの反映（{progress.applications.length} 回）</summary>
          {progress.applications.map((application, index) => (
            <p key={application.id}>
              反映 {index + 1}：{application.concepts.length} 個の概念{" "}
              <button
                disabled={running}
                onClick={() =>
                  run(async () => {
                    await deleteJson(
                      "/api/v1/import-sessions/" + encodeURIComponent(application.id),
                    );
                    setMessage("この反映を取り消しました。マップの表示を更新します。");
                    await router.invalidate();
                  })
                }
              >
                この反映を取り消す
              </button>
            </p>
          ))}
        </details>
      )}
    </section>
  );
}
