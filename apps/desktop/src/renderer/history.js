/**
 * 履歴インポート wizard（Issue #157）。
 *
 * 検出 → 解析 → プレビュー（除外可）→ 適用 / Undo の流れを管理する。
 * 解析状態は main プロセスが持ち、ここには画面状態だけを置く。
 */

const $ = (id) => document.getElementById(id);

const PROVIDER_LABELS = {
  codex: "Codex",
  "claude-code": "Claude Code",
  vscode: "VS Code",
  chatgpt: "ChatGPT",
  claude: "Claude",
  copilot: "GitHub Copilot",
  cursor: "Cursor",
  gemini: "Gemini",
};

const ANALYZER_LABELS = {
  "codex-cli": "Codex CLI",
  "claude-cli": "Claude CLI",
  managed: "Managed AI",
};

/**
 * @param {{ showError: (m: string) => void, showNotice: (m: string) => void, inertTargets: HTMLElement[] }} deps
 */
export function setupImportWizard(deps) {
  const panel = $("import");
  const steps = {
    sources: $("import-step-sources"),
    progress: $("import-step-progress"),
    result: $("import-step-result"),
    applied: $("import-step-applied"),
  };
  const runButton = $("import-run");
  const applyButton = $("import-apply");
  const undoButton = $("import-undo");

  let detections = null;
  let preview = null;
  let appliedSessionId = null;
  let analyzing = false;
  let applying = false;
  let filePath = null;

  const showStep = (name) => {
    for (const [key, element] of Object.entries(steps)) {
      element.hidden = key !== name;
    }
    runButton.hidden = name !== "sources";
    applyButton.hidden = name !== "result";
    undoButton.hidden = name !== "applied";
  };

  const setImportError = (message = "") => {
    $("import-error").textContent = message;
  };

  const renderSources = () => {
    const list = $("import-sources");
    list.replaceChildren(
      ...(detections?.sources ?? []).map((source) => {
        const item = document.createElement("li");
        const label = document.createElement("label");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = source.available;
        checkbox.disabled = !source.available;
        checkbox.dataset.provider = source.provider;
        const text = document.createElement("span");
        text.textContent = source.available
          ? `✓ ${PROVIDER_LABELS[source.provider] ?? source.provider}${
              source.estimatedCount ? `（${source.estimatedCount}件）` : ""
            }`
          : `— ${PROVIDER_LABELS[source.provider] ?? source.provider}: ${source.detail ?? "見つかりません"}`;
        label.append(checkbox, text);
        item.append(label);
        return item;
      }),
    );
    const analyzers = (detections?.analyzers ?? [])
      .map((a) => `${a.available ? "✓" : "—"} ${ANALYZER_LABELS[a.id] ?? a.id}`)
      .join("  ");
    $("import-analyzers").textContent = analyzers ? `分析に使えるもの: ${analyzers}` : "";
  };

  const renderResult = () => {
    const summary = $("import-summary");
    summary.textContent = `${preview.conversationCount} 件の会話から ${preview.evidenceCount} 件の Concept 観測を見つけました。`;
    const list = $("import-concepts");
    list.replaceChildren(
      ...preview.conceptSummaries.map((concept) => {
        const item = document.createElement("li");
        const label = document.createElement("label");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = true;
        checkbox.dataset.conceptId = concept.conceptId;
        const familiarity = preview.familiarity?.[concept.conceptId];
        const provenance = (familiarity?.sources ?? [])
          .map((s) => `${PROVIDER_LABELS[s.provider] ?? s.provider} ${s.count}件`)
          .join("・");
        const text = document.createElement("span");
        text.textContent = `${concept.label} — ${concept.count}件${provenance ? `（${provenance}）` : ""}`;
        label.append(checkbox, text);
        item.append(label);
        return item;
      }),
    );
    const detailWrap = $("import-detail-wrap");
    detailWrap.hidden = preview.warnings.length === 0 && preview.unmapped.length === 0;
    $("import-warnings").replaceChildren(
      ...preview.warnings.map((w) => {
        const li = document.createElement("li");
        li.textContent = w;
        return li;
      }),
    );
    $("import-unmapped").replaceChildren(
      ...preview.unmapped.slice(0, 50).map((u) => {
        const li = document.createElement("li");
        li.textContent = `未対応の候補: ${u.candidate}`;
        return li;
      }),
    );
    $("import-paste-area").hidden = !preview.canCopyPrompt;
    if (preview.unanalyzedCount > 0) {
      deps.showNotice(
        `${preview.unanalyzedCount} 件の会話は分析できませんでした（AI が使えないか予算の上限）。`,
      );
    }
  };

  const open = async () => {
    panel.hidden = false;
    deps.inertTargets.forEach((element) => element.setAttribute("inert", ""));
    showStep("sources");
    setImportError();
    try {
      detections = await window.desktop.historyDetect();
      renderSources();
    } catch (e) {
      setImportError(`履歴の検出に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const close = () => {
    panel.hidden = true;
    deps.inertTargets.forEach((element) => element.removeAttribute("inert"));
  };

  $("import-open").onclick = () => {
    void open();
  };
  $("import-close").onclick = close;

  $("import-pick").onclick = async () => {
    try {
      const picked = await window.desktop.historyPickFile();
      if (picked) {
        filePath = picked;
        $("import-file-provider").hidden = false;
        $("import-file-name").textContent = picked.split(/[\\/]/).pop();
      }
    } catch (e) {
      setImportError(`ファイルを選べませんでした: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // 再送信は状態で止める（RULE-007）。disabled は見た目だけにしない。
  runButton.onclick = async () => {
    if (analyzing) return;
    const providers = [...$("import-sources").querySelectorAll("input:checked")].map(
      (input) => input.dataset.provider,
    );
    if (providers.length === 0 && !filePath) {
      setImportError("取り込む履歴を1つ以上選んでください。");
      return;
    }
    analyzing = true;
    runButton.disabled = true;
    showStep("progress");
    setImportError();
    try {
      preview = await window.desktop.historyAnalyze({
        providers,
        ...(filePath ? { filePath, fileProvider: $("import-file-provider").value } : {}),
      });
      showStep("result");
      renderResult();
    } catch (e) {
      showStep("sources");
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      analyzing = false;
      runButton.disabled = false;
    }
  };

  window.desktop.onHistoryProgress((progress) => {
    if (!analyzing) return;
    const list = $("import-progress-list");
    const existing = [...list.children].find((li) => li.dataset.provider === progress.provider);
    const item = existing ?? document.createElement("li");
    item.dataset.provider = progress.provider;
    item.textContent = `${PROVIDER_LABELS[progress.provider] ?? progress.provider ?? ""} ${
      progress.phase === "scanning" ? "✓" : "analyzing..."
    }`;
    if (!existing) list.append(item);
    const percent =
      progress.totalCount > 0
        ? Math.round((progress.analyzedCount / progress.totalCount) * 100)
        : 0;
    $("import-bar").style.width = `${percent}%`;
  });

  $("import-copy-prompt").onclick = async () => {
    try {
      const prompt = await window.desktop.historyBuildPrompt();
      await navigator.clipboard.writeText(prompt);
      deps.showNotice("プロンプトをコピーしました。");
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    }
  };

  $("import-paste-apply").onclick = async () => {
    const text = $("import-paste").value.trim();
    if (!text) {
      setImportError("AI が返した JSON を貼り付けてください。");
      return;
    }
    try {
      preview = await window.desktop.historyPasteAnalysis(text);
      renderResult();
      deps.showNotice("分析結果を取り込みました。");
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    }
  };

  applyButton.onclick = async () => {
    if (applying) return;
    applying = true;
    applyButton.disabled = true;
    try {
      const excludeConceptIds = [...$("import-concepts").querySelectorAll("input")]
        .filter((input) => !input.checked)
        .map((input) => input.dataset.conceptId);
      const result = await window.desktop.historyApply({ excludeConceptIds });
      appliedSessionId = result.id;
      $("import-applied-message").textContent = result.alreadyExisted
        ? "この Import はすでに適用済みです。"
        : `${result.evidenceCount} 件の観測を Learning Map に適用しました。`;
      showStep("applied");
      deps.showNotice("Learning Map を更新しました。");
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      applying = false;
      applyButton.disabled = false;
    }
  };

  undoButton.onclick = async () => {
    if (!appliedSessionId) return;
    try {
      const result = await window.desktop.historyUndo(appliedSessionId);
      $("import-applied-message").textContent =
        `Import を取り消しました（観測 ${result.deletedEvidenceCount} 件を削除）。`;
      appliedSessionId = null;
      undoButton.hidden = true;
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    }
  };

  return { close, isOpen: () => !panel.hidden };
}
