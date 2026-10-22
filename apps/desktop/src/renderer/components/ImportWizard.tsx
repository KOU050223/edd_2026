// 履歴インポート wizard（Issue #157）。history.js の全段階を React へ移したもの。
// 検出 → 解析 → プレビュー（除外可）→ 適用 / Undo の流れを管理する。
// 解析状態は main プロセスが持ち、ここには画面状態だけを置く。
import { useCallback, useEffect, useRef, useState } from "react";

import type { HistoryProviderId } from "@gakushu-sochi/domain";

import type { HistoryDetectResult, ImportAnalyzeView, ImportProgress } from "../../shared/types.js";
import { useDesktopEvent } from "../hooks/use-desktop-event.js";

const PROVIDER_LABELS: Record<string, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  vscode: "VS Code",
  chatgpt: "ChatGPT",
  claude: "Claude",
  copilot: "GitHub Copilot",
  cursor: "Cursor",
  gemini: "Gemini",
};

const ANALYZER_LABELS: Record<string, string> = {
  "codex-cli": "Codex CLI",
  "claude-cli": "Claude CLI",
  managed: "Managed AI",
};

type Step = "sources" | "progress" | "result" | "applied";

interface Props {
  open: boolean;
  onClose: () => void;
  // エラーは #import-error へ出すため showError は要らない。通知だけを受け取る。
  showNotice: (message?: string) => void;
}

export function ImportWizard({ open, onClose, showNotice }: Props) {
  const [step, setStep] = useState<Step>("sources");
  const [importError, setImportError] = useState("");
  const [detections, setDetections] = useState<HistoryDetectResult | null>(null);
  const [checkedProviders, setCheckedProviders] = useState<ReadonlySet<HistoryProviderId>>(
    new Set(),
  );
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileProvider, setFileProvider] = useState<HistoryProviderId>("chatgpt");
  const [preview, setPreview] = useState<ImportAnalyzeView | null>(null);
  const [excludedConcepts, setExcludedConcepts] = useState<ReadonlySet<string>>(new Set());
  const [progressItems, setProgressItems] = useState<ImportProgress[]>([]);
  const [barPercent, setBarPercent] = useState(0);
  const [appliedSessionId, setAppliedSessionId] = useState<string | null>(null);
  const [appliedMessage, setAppliedMessage] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [applying, setApplying] = useState(false);
  // 入口で弾く同期ガード（RULE-007）。disabled は見た目でしかない。
  const analyzingRef = useRef(false);
  const applyingRef = useRef(false);

  // 「開いたらソース選択に戻る」ための派生状態更新。effect ではなく
  // レンダー中の adjusting state（React が認めるパターン）で行う。
  // パネルを閉じても分析・プレビューの状態は残る（旧 history.js と同じ扱い）。
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setStep("sources");
      setImportError("");
    }
  }

  // 開くたびにソースの検出からやり直す。
  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const result = await window.desktop.historyDetect();
        setDetections(result);
        setCheckedProviders(
          new Set(result.sources.filter((s) => s.available).map((s) => s.provider)),
        );
      } catch (e) {
        setImportError(`履歴の検出に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  }, [open]);

  // 進捗イベントは分析中だけ取り込む。
  useDesktopEvent(window.desktop.onHistoryProgress, (progress) => {
    if (!analyzingRef.current) return;
    setProgressItems((previous) => {
      const index = previous.findIndex((item) => item.provider === progress.provider);
      const next = [...previous];
      if (index < 0) next.push(progress);
      else next[index] = progress;
      return next;
    });
    setBarPercent(
      progress.totalCount > 0
        ? Math.round((progress.analyzedCount / progress.totalCount) * 100)
        : 0,
    );
  });

  const pickFile = useCallback(async () => {
    try {
      const picked = await window.desktop.historyPickFile();
      if (picked) setFilePath(picked);
    } catch (e) {
      setImportError(`ファイルを選べませんでした: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const toggleProvider = useCallback((provider: HistoryProviderId, checked: boolean) => {
    setCheckedProviders((previous) => {
      const next = new Set(previous);
      if (checked) next.add(provider);
      else next.delete(provider);
      return next;
    });
  }, []);

  // 再送信は状態で止める（RULE-007）。disabled は見た目だけにしない。
  const run = useCallback(async () => {
    if (analyzingRef.current) return;
    const providers = [...checkedProviders];
    if (providers.length === 0 && filePath === null) {
      setImportError("取り込む履歴を1つ以上選んでください。");
      return;
    }
    analyzingRef.current = true;
    setAnalyzing(true);
    setStep("progress");
    setImportError("");
    try {
      const result = await window.desktop.historyAnalyze({
        providers,
        ...(filePath !== null ? { filePath, fileProvider } : {}),
      });
      setPreview(result);
      setExcludedConcepts(new Set());
      setStep("result");
      if (result.unanalyzedCount > 0) {
        showNotice(
          `${result.unanalyzedCount} 件の会話は分析できませんでした（AI が使えないか予算の上限）。`,
        );
      }
    } catch (e) {
      setStep("sources");
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      analyzingRef.current = false;
      setAnalyzing(false);
    }
  }, [checkedProviders, filePath, fileProvider, showNotice]);

  const copyPrompt = useCallback(async () => {
    try {
      const prompt = await window.desktop.historyBuildPrompt();
      await navigator.clipboard.writeText(prompt);
      showNotice("プロンプトをコピーしました。");
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    }
  }, [showNotice]);

  const applyPaste = useCallback(async () => {
    const text = pasteText.trim();
    if (!text) {
      setImportError("AI が返した JSON を貼り付けてください。");
      return;
    }
    try {
      const result = await window.desktop.historyPasteAnalysis(text);
      setPreview(result);
      setExcludedConcepts(new Set());
      showNotice("分析結果を取り込みました。");
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    }
  }, [pasteText, showNotice]);

  const toggleConcept = useCallback((conceptId: string, included: boolean) => {
    setExcludedConcepts((previous) => {
      const next = new Set(previous);
      if (included) next.delete(conceptId);
      else next.add(conceptId);
      return next;
    });
  }, []);

  const apply = useCallback(async () => {
    if (applyingRef.current) return;
    applyingRef.current = true;
    setApplying(true);
    try {
      const result = await window.desktop.historyApply({
        excludeConceptIds: [...excludedConcepts],
      });
      setAppliedSessionId(result.id);
      setAppliedMessage(
        result.alreadyExisted
          ? "この Import はすでに適用済みです。"
          : `${result.evidenceCount} 件の観測を Learning Map に適用しました。`,
      );
      setStep("applied");
      showNotice("Learning Map を更新しました。");
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      applyingRef.current = false;
      setApplying(false);
    }
  }, [excludedConcepts, showNotice]);

  const undo = useCallback(async () => {
    if (appliedSessionId === null) return;
    try {
      const result = await window.desktop.historyUndo(appliedSessionId);
      setAppliedMessage(
        `Import を取り消しました（観測 ${result.deletedEvidenceCount} 件を削除）。`,
      );
      setAppliedSessionId(null);
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    }
  }, [appliedSessionId]);

  const analyzersLine = (detections?.analyzers ?? [])
    .map((a) => `${a.available ? "✓" : "—"} ${ANALYZER_LABELS[a.id] ?? a.id}`)
    .join("  ");

  return (
    <section
      id="import"
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-title"
      hidden={!open}
    >
      <div className="settings-panel import-panel">
        <h2 id="import-title">これまでの学習から Learning Map を作ります</h2>
        <p id="import-error" role="alert">
          {importError}
        </p>

        <div id="import-step-sources" hidden={step !== "sources"}>
          <p className="import-lead">このPCで見つかった学習履歴</p>
          <ul id="import-sources" className="import-sources">
            {(detections?.sources ?? []).map((source) => (
              <li key={source.provider}>
                <label>
                  <input
                    type="checkbox"
                    data-provider={source.provider}
                    disabled={!source.available}
                    checked={source.available && checkedProviders.has(source.provider)}
                    onChange={(event) => toggleProvider(source.provider, event.target.checked)}
                  />
                  <span>
                    {source.available
                      ? `✓ ${PROVIDER_LABELS[source.provider] ?? source.provider}${
                          source.estimatedCount ? `（${source.estimatedCount}件）` : ""
                        }`
                      : `— ${PROVIDER_LABELS[source.provider] ?? source.provider}: ${
                          source.detail ?? "見つかりません"
                        }`}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="import-file">
            <button type="button" id="import-pick" onClick={() => void pickFile()}>
              エクスポートファイルを選ぶ
            </button>
            <select
              id="import-file-provider"
              hidden={filePath === null}
              value={fileProvider}
              onChange={(event) => setFileProvider(event.target.value as HistoryProviderId)}
            >
              <option value="chatgpt">ChatGPT エクスポート</option>
              <option value="claude">Claude エクスポート</option>
            </select>
            <span id="import-file-name">{filePath?.split(/[\\/]/).pop() ?? ""}</span>
          </div>
          <p id="import-analyzers" className="import-note">
            {analyzersLine ? `分析に使えるもの: ${analyzersLine}` : ""}
          </p>
        </div>

        <div id="import-step-progress" hidden={step !== "progress"}>
          <p className="import-lead">過去の学習を読み解いています</p>
          <ul id="import-progress-list" className="import-sources">
            {progressItems.map((progress) => (
              <li key={progress.provider ?? ""} data-provider={progress.provider ?? ""}>
                {`${PROVIDER_LABELS[progress.provider ?? ""] ?? progress.provider ?? ""} ${
                  progress.phase === "scanning" ? "✓" : "analyzing..."
                }`}
              </li>
            ))}
          </ul>
          <div className="progress">
            <div id="import-bar" className="progress-bar" style={{ width: `${barPercent}%` }} />
          </div>
        </div>

        <div id="import-step-result" hidden={step !== "result"}>
          <p className="import-lead" id="import-summary">
            {preview === null
              ? ""
              : `${preview.conversationCount} 件の会話から ${preview.evidenceCount} 件の Concept 観測を見つけました。`}
          </p>
          <ul id="import-concepts" className="import-concepts">
            {(preview?.conceptSummaries ?? []).map((concept) => {
              const familiarity = preview?.familiarity[concept.conceptId];
              const provenance = (familiarity?.sources ?? [])
                .map((s) => `${PROVIDER_LABELS[s.provider] ?? s.provider} ${s.count}件`)
                .join("・");
              return (
                <li key={concept.conceptId}>
                  <label>
                    <input
                      type="checkbox"
                      data-concept-id={concept.conceptId}
                      checked={!excludedConcepts.has(concept.conceptId)}
                      onChange={(event) => toggleConcept(concept.conceptId, event.target.checked)}
                    />
                    <span>
                      {`${concept.label} — ${concept.count}件${provenance ? `（${provenance}）` : ""}`}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <details
            id="import-detail-wrap"
            hidden={
              preview === null || (preview.warnings.length === 0 && preview.unmapped.length === 0)
            }
          >
            <summary>詳細</summary>
            <ul id="import-warnings">
              {(preview?.warnings ?? []).map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
            <ul id="import-unmapped">
              {(preview?.unmapped ?? []).slice(0, 50).map((unmapped) => (
                <li key={unmapped.sourceId}>{`未対応の候補: ${unmapped.candidate}`}</li>
              ))}
            </ul>
          </details>
          <div id="import-paste-area" hidden={preview?.canCopyPrompt !== true}>
            <p className="import-note">
              自動で分析できなかった会話があります。プロンプトをコピーしてお持ちの AI
              に貼り、返ってきた JSON を下に貼り付けてください。
            </p>
            <button type="button" id="import-copy-prompt" onClick={() => void copyPrompt()}>
              プロンプトをコピー
            </button>
            <textarea
              id="import-paste"
              rows={4}
              placeholder='{"observations": [...]}'
              value={pasteText}
              onChange={(event) => setPasteText(event.target.value)}
            />
            <button type="button" id="import-paste-apply" onClick={() => void applyPaste()}>
              分析結果を取り込む
            </button>
          </div>
        </div>

        <div id="import-step-applied" hidden={step !== "applied"}>
          <p className="import-lead" id="import-applied-message">
            {appliedMessage}
          </p>
        </div>

        <div className="settings-actions">
          <button type="button" id="import-close" onClick={onClose}>
            閉じる
          </button>
          <button
            type="button"
            id="import-undo"
            hidden={step !== "applied" || appliedSessionId === null}
            onClick={() => void undo()}
          >
            この Import を取り消す
          </button>
          <button
            type="button"
            id="import-run"
            hidden={step !== "sources"}
            disabled={analyzing}
            onClick={() => void run()}
          >
            Learning Map を作る
          </button>
          <button
            type="button"
            id="import-apply"
            hidden={step !== "result"}
            disabled={applying}
            onClick={() => void apply()}
          >
            地図に適用
          </button>
        </div>
      </div>
    </section>
  );
}
