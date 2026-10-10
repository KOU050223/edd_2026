import { toErrorText } from "./errors.js";
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
  pendingHistory,
  previewHistory,
  reconcileHistoryProgress,
  selectHistoryBatch,
  HISTORY_ANALYSIS_VERSION,
  HISTORY_CALL_LIMIT,
  type HistoryProgress,
  type HistoryTarget,
} from "./history-analysis.js";

export function HistoryMapPanel({ target }: { target: string }) {
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
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
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
        if (mounted.current) {
          setData({ userId, questions: historyQuestions(files), target: definition, usage });
          setOpened(true);
        }
      } finally {
        store.close();
      }
    });
  const invalidPeriod = !!(from && to && from > to);
  const selection = data && !invalidPeriod ? filterHistory(data.questions, project, from, to) : [];
  const selectionKey = JSON.stringify([target, project, from, to]);
  const changeFilter = (action: () => void) => {
    action();
    setProgress(undefined);
    setExcluded([]);
  };
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
          throw new Error(
            "応答を確認できていない適用があります。「保存済みの進捗を読む」から適用を再送してください",
          );
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
            if (localHistoryMatch(item.question, concept))
              current.classifications.push({
                question: item.question.key,
                inputFingerprint: item.question.fingerprint,
                concept: concept.id,
                definitionFingerprint: concept.fingerprint,
                confidence: 1,
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
          setMessage(`解析中：呼び出し ${used + 1} / ${calls}、未解析 ${pending.length} 質問`);
          const result = await analyzeHistoryBatch(batch, concepts, target);
          current = { ...current, classifications: [...current.classifications, ...result] };
          used++;
          await save();
        }
        if (mounted.current)
          setMessage(
            `解析済みの結果を保存しました。未解析 ${pendingHistory(questions, definition, current).length} 質問。${cancel.current ? "中断しました。" : "上限や同意待ちの残りは後から再開できます。"}`,
          );
      } finally {
        store.close();
      }
    });
  const resume = () =>
    run(async () => {
      if (!data) return;
      if ((await historyUserId()) !== data.userId) throw new Error("アカウントが変わりました");
      const store = await openHistoryStore(data.userId);
      try {
        const saved = await store.loadProgress<HistoryProgress>(selectionKey);
        const definition = await fetchHistoryTarget(target);
        const questions = historyQuestions(await store.files());
        if (!saved) throw new Error("このマップ・プロジェクト・期間の保存済み進捗がありません");
        if (mounted.current) {
          setData({ ...data, questions, target: definition });
          setExcluded(saved.excludedConceptIds ?? []);
          setProgress(
            reconcileHistoryProgress(
              saved,
              filterHistory(questions, project, from, to),
              definition,
            ),
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
        if (mounted.current) {
          setProgress(next);
          setExcluded(next.excludedConceptIds ?? []);
          setMessage(
            `反映しました：この反映の観測 ${saved.evidenceCount} 件（既存の観測は二重計上しません）`,
          );
        }
        await router.invalidate();
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
  if (!opened)
    return (
      <section className="message">
        <button disabled={running} onClick={open}>
          取り込んだ履歴から反映
        </button>{" "}
        <Link to="/local-history">履歴管理</Link>
        {error && <p role="alert">{error}</p>}
      </section>
    );
  const preview = data && progress ? previewHistory(selection, data.target, progress) : [];
  return (
    <section className="message">
      <h2>このマップへ履歴を反映</h2>
      <p>
        <Link to="/local-history">履歴の取り込み・更新・削除</Link>
        は履歴管理で行います。履歴は「触れた形跡」にだけ反映し、理解度を上げません。
      </p>
      <label>
        プロジェクト{" "}
        <select
          disabled={running || !!progress?.pendingApplication}
          value={project}
          onChange={(event) => changeFilter(() => setProject(event.target.value))}
        >
          <option value="">すべて</option>
          {[...new Set(data?.questions.map((question) => question.project))].map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
      </label>
      <label>
        開始日（UTC）{" "}
        <input
          type="date"
          disabled={running || !!progress?.pendingApplication}
          value={from}
          max={to || undefined}
          onChange={(event) => changeFilter(() => setFrom(event.target.value))}
        />
      </label>
      <label>
        終了日（UTC）{" "}
        <input
          type="date"
          disabled={running || !!progress?.pendingApplication}
          value={to}
          min={from || undefined}
          onChange={(event) => changeFilter(() => setTo(event.target.value))}
        />
      </label>
      <p>
        対象 {historyQuestionCount(selection)} 質問（解析素材 {selection.length} 分割）。Gakushu
        Managed AI（Google
        Gemini）へ、マスク済み質問・周辺回答・このマップの候補定義を送信します。会話全文はサーバーに保存しません。1回の操作は最大{" "}
        {HISTORY_CALL_LIMIT} 呼び出し、現在の残り利用枠 {data ? remainingRequests(data.usage) : 0}{" "}
        回。マスクの限界があるため、送信前に素材を確認してください。
      </p>
      <details>
        <summary>送信する素材を確認</summary>
        {selection.map((question) => (
          <pre key={question.key}>{question.body}</pre>
        ))}
      </details>
      <p>
        適用は1回5000観測までです。残りがあれば、もう一度適用してください。再解析しても以前の観測は消えません。誤った以前の反映は履歴管理から
        Undo できます。
      </p>
      <label>
        <input
          type="checkbox"
          disabled={running}
          checked={consent}
          onChange={(event) => setConsent(event.target.checked)}
        />
        上記の内容と利用枠を確認し、AI への送信に同意する
      </label>
      <div className="actions">
        <button disabled={running || !selection.length} onClick={analyze}>
          解析 / 未解析分を再開
        </button>
        <button disabled={running} onClick={resume}>
          保存済みの進捗を読む
        </button>
        <button
          disabled={!running}
          onClick={() => {
            cancel.current = true;
          }}
        >
          この呼び出し後に中断
        </button>
        <button
          disabled={running || (!preview.length && !progress?.pendingApplication)}
          onClick={apply}
        >
          {progress?.pendingApplication ? "同じ適用を再送" : "選択した Concept を適用"}
        </button>
        {progress?.pendingApplication && (
          <button disabled={running} onClick={rebuild}>
            適用結果を照合してプレビューを作り直す
          </button>
        )}
      </div>
      {data?.target.warnings.map((warning) => (
        <p key={warning} role="alert">
          {warning}
        </p>
      ))}
      {invalidPeriod && <p role="alert">開始日を終了日以前にしてください。</p>}
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th>適用</th>
            <th>Concept</th>
            <th>関連質問件数</th>
            <th>最終日時（UTC）</th>
          </tr>
        </thead>
        <tbody>
          {preview.map((row) => (
            <tr key={row.concept.id}>
              <td>
                <input
                  type="checkbox"
                  aria-label={`${row.concept.label} を適用`}
                  disabled={running || !!progress?.pendingApplication}
                  checked={!excluded.includes(row.concept.id)}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    run(async () => {
                      if (!data || !progress) return;
                      if ((await historyUserId()) !== data.userId)
                        throw new Error("アカウントが変わりました");
                      const nextExcluded = checked
                        ? excluded.filter((id) => id !== row.concept.id)
                        : [...excluded, row.concept.id];
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
                  }}
                />
              </td>
              <td>
                {row.concept.label} <small>{row.concept.id}</small>
              </td>
              <td>{row.count}</td>
              <td>{row.lastObservedAt}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {progress?.applications.map((application) => (
        <p key={application.id}>
          {application.id}{" "}
          <button
            disabled={running}
            onClick={() =>
              run(async () => {
                await deleteJson(`/api/v1/import-sessions/${encodeURIComponent(application.id)}`);
                setMessage(
                  "この反映の追加分を Undo しました。同じ ID を参照するほかのマップからも消えます",
                );
                await router.invalidate();
              })
            }
          >
            この反映を Undo
          </button>
        </p>
      ))}
    </section>
  );
}
