import { renderMarkdown } from "./markdown.js";
import { AUTH_LABELS, authStatusLabel, shouldApplyAuthState } from "./auth-status.js";
import { setupImportWizard } from "./history.js";

const $ = (id) => document.getElementById(id);
const error = $("error"),
  selection = $("selection"),
  code = $("code"),
  question = $("question"),
  answer = $("answer"),
  send = $("send"),
  card = $("card"),
  cardTitle = $("card-title"),
  chips = $("chips"),
  form = $("settings-form");
// 設定シート表示中に inert 化する領域（form 自身は含めない）。
const backdrop = [$("titlebar"), $("workspace")];
let isAsking = false;
let answerMarkdown = "";

// ---------------------------------------------------------------------------
// 質問履歴（Issue #199）。左サイドバーは Learning Map ではなく履歴を出す。
// 一覧は GET /v1/conversations の要約（本文なし）で、クリックした行だけ
// 詳細を取り、選択テキストと回答カードへ写す。本文は端末へ永続化しない。
// ---------------------------------------------------------------------------
const conversationsList = $("conversations");
const conversationsNote = $("conversations-note");
const conversationsMore = $("conversations-more");
let conversationsNextCursor = null;
let loadingMoreConversations = false;
// 再読み込みが重なったとき、古い応答で新しい表示を上書きしない（RULE-005）。
let conversationsLoadGeneration = 0;
let conversationDetailGeneration = 0;
// 詳細表示中の会話 ID。「履歴を削除」ボタンの対象になる。
let viewingConversationId = null;
let deletingConversation = false;
let deleteArmed = false;
let deleteArmTimer;

const ORIGIN_LABELS = {
  desktop: "デスクトップ",
  vscode: "VS Code",
  web: "Web",
  cli: "CLI",
};

const conversationMetaLine = (summary) =>
  [
    new Date(summary.occurredAt).toLocaleString("ja-JP"),
    ORIGIN_LABELS[summary.origin] ?? summary.origin,
    summary.fileName,
  ]
    .filter(Boolean)
    .join("・");

const conversationItem = (summary) => {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "conversation";
  button.dataset.id = summary.id;
  button.dataset.current = String(summary.id === viewingConversationId);
  const title = document.createElement("span");
  title.className = "conversation-title";
  title.textContent = summary.title ?? "（タイトルなし）";
  if (summary.complete === false) {
    const badge = document.createElement("span");
    badge.className = "conversation-incomplete";
    badge.textContent = "中断";
    title.append(badge);
  }
  const meta = document.createElement("span");
  meta.className = "conversation-meta";
  meta.textContent = conversationMetaLine(summary);
  button.append(title, meta);
  button.onclick = () => void openConversation(summary.id);
  item.append(button);
  return item;
};

const renderConversations = (summaries) => {
  conversationsList.replaceChildren(...summaries.map(conversationItem));
};

const loadConversations = async () => {
  const generation = ++conversationsLoadGeneration;
  try {
    const page = await window.desktop.listConversations();
    if (generation !== conversationsLoadGeneration) return;
    conversationsNextCursor = page.nextCursor;
    renderConversations(page.conversations);
    conversationsNote.hidden = page.conversations.length !== 0;
    conversationsNote.textContent = "まだ質問履歴がありません。";
    conversationsMore.hidden = conversationsNextCursor === null;
  } catch (e) {
    if (generation !== conversationsLoadGeneration) return;
    // 一覧が出せなくても質問はできるので、致命傷にはしない。
    // 未ログインの場合も getAccessToken の文言がそのまま案内になる。
    conversationsList.replaceChildren();
    conversationsMore.hidden = true;
    conversationsNote.hidden = false;
    conversationsNote.textContent = `質問履歴を読み込めませんでした: ${
      e instanceof Error ? e.message : String(e)
    }`;
  }
};

conversationsMore.onclick = async () => {
  // 入口で弾く（RULE-007）。disabled は見た目でしかない。
  if (loadingMoreConversations || conversationsNextCursor === null) return;
  loadingMoreConversations = true;
  conversationsMore.disabled = true;
  const generation = conversationsLoadGeneration;
  try {
    const page = await window.desktop.listConversations(conversationsNextCursor);
    // 読み込み中に一覧が読み直されたら、続きは新しい一覧に対して取り直す。
    if (generation !== conversationsLoadGeneration) return;
    conversationsNextCursor = page.nextCursor;
    conversationsList.append(...page.conversations.map(conversationItem));
    conversationsMore.hidden = conversationsNextCursor === null;
  } catch (e) {
    showError(
      `質問履歴の続きを読み込めませんでした: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    loadingMoreConversations = false;
    conversationsMore.disabled = false;
  }
};

const resetHistoryDelete = () => {
  if (deleteArmTimer !== undefined) window.clearTimeout(deleteArmTimer);
  deleteArmTimer = undefined;
  deleteArmed = false;
  const button = $("history-delete");
  button.textContent = "履歴を削除";
  button.dataset.armed = "false";
};

const renderConversation = (conversation) => {
  const context = conversation.messages.find((message) => message.role === "context");
  const user = conversation.messages.find((message) => message.role === "user");
  const assistant = [...conversation.messages]
    .reverse()
    .find((message) => message.role === "assistant");
  if (context !== undefined) renderCode(context.text);
  resetCard();
  cardTitle.textContent = conversation.title ?? user?.text ?? "回答";
  answerMarkdown = assistant?.text ?? "";
  answer.innerHTML = renderMarkdown(answerMarkdown);
  if (!conversation.complete) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = "回答は途中で中断されました";
    chips.append(chip);
    chips.hidden = false;
  }
  card.hidden = false;
  thread.scrollTop = 0;
};

const openConversation = async (id) => {
  const generation = ++conversationDetailGeneration;
  try {
    const conversation = await window.desktop.getConversation(id);
    if (generation !== conversationDetailGeneration) return;
    // resetCard が viewingConversationId を null に戻すため、詳細を描いてから立てる。
    renderConversation(conversation);
    viewingConversationId = id;
    $("history-delete").hidden = false;
    for (const button of conversationsList.querySelectorAll(".conversation")) {
      button.dataset.current = String(button.dataset.id === id);
    }
  } catch (e) {
    if (generation !== conversationDetailGeneration) return;
    showError(`履歴を開けませんでした: ${e instanceof Error ? e.message : String(e)}`);
  }
};

$("history-delete").onclick = async () => {
  if (viewingConversationId === null || deletingConversation) return;
  const button = $("history-delete");
  // 不可逆操作なので二段階にする。一定時間で自動解除する。
  if (!deleteArmed) {
    deleteArmed = true;
    button.textContent = "もう一度押すと削除";
    button.dataset.armed = "true";
    deleteArmTimer = window.setTimeout(resetHistoryDelete, 5000);
    return;
  }
  window.clearTimeout(deleteArmTimer);
  deleteArmTimer = undefined;
  deletingConversation = true;
  button.disabled = true;
  try {
    await window.desktop.deleteConversation(viewingConversationId);
    viewingConversationId = null;
    button.hidden = true;
    card.hidden = true;
    resetHistoryDelete();
    showNotice("履歴を削除しました。");
    void loadConversations();
  } catch (e) {
    resetHistoryDelete();
    showError(`履歴を削除できませんでした: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    deletingConversation = false;
    button.disabled = false;
  }
};

// 選択テキストは #selection が唯一の保持先。#code は表示用の写し。
// 冒頭行（宣言部）だけ帯を敷いて、どこを聞いているかを示す。
const renderCode = (text) => {
  selection.value = text;
  const [first, ...rest] = text.split("\n");
  const head = document.createElement("span");
  head.className = "hl";
  head.textContent = first ?? "";
  code.replaceChildren(head, document.createTextNode(rest.length ? `\n${rest.join("\n")}` : ""));
};

// #error は失敗と成功の両方を出す共有チャネル。CSS が data-tone で色を出し分ける。
const showError = (message = "") => {
  error.textContent = message;
  error.dataset.tone = "error";
};
const showNotice = (message = "") => {
  error.textContent = message;
  error.dataset.tone = "notice";
};

void loadConversations();

const accessibility = document.createElement("button");
// type を明示しないと submit 扱いになり、primary のスタイルも拾ってしまう。
accessibility.type = "button";
accessibility.textContent = "アクセシビリティ設定を開く";
accessibility.onclick = async () => {
  try {
    await window.desktop.openAccessibilitySettings();
  } catch (e) {
    showError(
      `アクセシビリティ設定を開けませんでした: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
};
$("settings-cancel").before(accessibility);

const resetCard = () => {
  cardTitle.textContent = "回答";
  answerMarkdown = "";
  answer.replaceChildren();
  chips.hidden = true;
  chips.replaceChildren();
  // 履歴の詳細表示は新しい選択・質問で切り替わるため、削除ボタンと対象を閉じる。
  viewingConversationId = null;
  resetHistoryDelete();
  $("history-delete").hidden = true;
};

const login = $("auth-login");
const logout = $("auth-logout");
// ログイン状態は main からの通知（auth:state）でも書き換わる。進行中かどうかは
// disabled ではなくこの状態で判断する（.agents/rules/rules.md RULE-007）。
let authView = { loggingIn: false, loggingOut: false, hasRefreshToken: false };

const renderAuthStatus = () => {
  $("auth-status").textContent = authStatusLabel(authView);
};

const setAuthState = (hasRefreshToken) => {
  authView = { ...authView, hasRefreshToken };
  renderAuthStatus();
};

login.onclick = async () => {
  if (authView.loggingIn || authView.loggingOut) return; // 入口で弾く。disabled は見た目でしかない。
  authView = { ...authView, loggingIn: true };
  login.disabled = true;
  renderAuthStatus();
  try {
    await window.desktop.login();
    authView = { ...authView, loggingIn: false, hasRefreshToken: true };
    renderAuthStatus();
  } catch (e) {
    authView = { ...authView, loggingIn: false };
    $("auth-status").textContent = AUTH_LABELS.failed;
    showError(e instanceof Error ? e.message : String(e));
  } finally {
    authView = { ...authView, loggingIn: false };
    login.disabled = false;
  }
};

logout.onclick = async () => {
  // 入口で弾く。disabled は見た目でしかない（RULE-007）。
  if (authView.loggingOut || authView.loggingIn) return;
  authView = { ...authView, loggingOut: true };
  logout.disabled = true;
  login.disabled = true;
  renderAuthStatus();
  try {
    await window.desktop.logout();
    authView = { loggingIn: false, loggingOut: false, hasRefreshToken: false };
    renderAuthStatus();
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
  } finally {
    // 失敗しても必ず戻す。try の末尾に置くとボタンが固まったままになる。
    authView = { ...authView, loggingOut: false };
    logout.disabled = false;
    login.disabled = false;
    renderAuthStatus();
  }
};

window.desktop.onAuthState(({ hasRefreshToken }) => {
  // ログイン中に届いた通知は取り込まない。走っているログインについて画面が嘘をつく。
  if (!shouldApplyAuthState({ ...authView, hasRefreshToken })) return;
  setAuthState(hasRefreshToken);
  // ログイン・ログアウトで履歴の見え方が変わるので読み直す。
  void loadConversations();
});

window.desktop.onSelection(({ selection: text, error: message }) => {
  renderCode(text);
  if (message) showError(message);
  else showNotice();
  resetCard();
  card.hidden = true;
  question.focus();
  // ショートカットで開くたびに履歴を最新にする。
  void loadConversations();
});
const thread = $("thread");
window.desktop.onDelta((delta) => {
  // 既に最下部を見ているときだけ、新しい行を追って自動スクロールする。
  const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 48;
  answerMarkdown += delta;
  answer.innerHTML = renderMarkdown(answerMarkdown);
  if (atBottom) thread.scrollTop = thread.scrollHeight;
});
answer.addEventListener("click", (event) => {
  const link = event.target?.closest?.("a");
  if (!link) return;
  event.preventDefault();
  void window.desktop.openExternalLink(link.href).catch((e) => {
    showError(`リンクを開けませんでした: ${e instanceof Error ? e.message : String(e)}`);
  });
});

$("retry").onclick = async () => {
  try {
    await window.desktop.retrySelection();
  } catch (e) {
    showError(e.message);
  }
};
$("close").onclick = () => window.desktop.close();
$("card-close").onclick = () => {
  card.hidden = true;
};

const ask = async () => {
  if (isAsking) return;
  isAsking = true;
  send.disabled = true;
  try {
    showNotice();
    resetCard();
    const asked = question.value.trim();
    cardTitle.textContent = asked || "回答";
    card.hidden = false;
    await window.desktop.ask(selection.value, question.value);
    // 履歴保存が有効なら新しい会話が保存されている。一覧を読み直す。
    void loadConversations();
  } catch (e) {
    showError(e.message);
  } finally {
    isAsking = false;
    send.disabled = false;
  }
};
send.onclick = ask;

const renderConsentStatus = ({ granted, grantedAt }) => {
  $("consent-status").textContent = granted
    ? `同意しています（${new Date(grantedAt).toLocaleString("ja-JP")}）`
    : "同意していません";
};

$("consent-review").onclick = async () => {
  try {
    // 文面の提示と取り消しは main 側のダイアログが担う。ここでは結果の状態だけ反映する。
    renderConsentStatus(await window.desktop.reviewConsent());
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
  }
};

// 「質問履歴の保存」オプトイン（Issue #204）。正はサーバーの user-settings。
// saveHistoryOptIn はフォーム送信でローカルキャッシュを維持するために持つ。
let saveHistoryOptIn = false;
const saveHistory = $("save-history");

const renderHistoryOptIn = (enabled) => {
  saveHistoryOptIn = enabled;
  saveHistory.checked = enabled;
  $("history-optin-status").textContent = enabled ? "オン" : "オフ";
};

// 読み込み失敗時は操作不能のまま残す（オフラインでは変更できない設計）。
const loadHistoryOptIn = async () => {
  saveHistory.disabled = true;
  try {
    const remote = await window.desktop.getConversationHistoryOptIn();
    renderHistoryOptIn(remote.saveConversationHistory);
    saveHistory.disabled = false;
  } catch (e) {
    $("history-optin-status").textContent = "読み込めませんでした";
    showError(
      `質問履歴の設定を読み込めませんでした: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
};

saveHistory.onchange = async () => {
  const next = saveHistory.checked;
  saveHistory.disabled = true;
  try {
    const result = await window.desktop.setConversationHistoryOptIn(next);
    // キャンセル時は main が現在値を返すので、戻った値に合わせて表示を戻す。
    renderHistoryOptIn(result.saveConversationHistory);
    saveHistory.disabled = false;
  } catch (e) {
    // 失敗時は表示を元に戻してから、サーバーの現在値で復元する。
    // finally で無条件に再有効化すると、戻りチェックが反映される前に
    // 次の変更を受け付けてしまう。
    renderHistoryOptIn(!next);
    showError(
      `質問履歴の設定を変更できませんでした: ${e instanceof Error ? e.message : String(e)}`,
    );
    void loadHistoryOptIn();
  }
};

// 履歴の保存失敗は回答の表示を止めないが、黙っても落とさない（RULE-004）。
window.desktop.onHistorySaveFailed((message) => showError(message));

const openSettings = async () => {
  const s = await window.desktop.getSettings();
  ["api-base-url", "shortcut", "model", "temperature", "max-tokens", "persona"].forEach((id) => {
    $(id).value = s[id === "api-base-url" ? "apiBaseUrl" : id === "max-tokens" ? "maxTokens" : id];
  });
  $("restore").checked = s.restoreClipboard;
  $("login").checked = s.launchAtLogin;
  // ローカルキャッシュの値を先に出し、サーバーの値が読めたら上書きする。
  renderHistoryOptIn(s.saveConversationHistory === true);
  setAuthState(s.hasRefreshToken);
  renderConsentStatus(await window.desktop.getConsentStatus());
  form.hidden = false;
  // モーダルの背後へ Tab で抜けさせない（inert は form の祖先には置けないため兄弟に置く）。
  backdrop.forEach((element) => element.setAttribute("inert", ""));
  $("api-base-url").focus();
  // サーバーの値を正として読み直す。失敗は中でエラー表示するので待たない。
  void loadHistoryOptIn();
};

// 履歴インポート wizard（Issue #157）。inert 対象は設定シートと同じ。
const importWizard = setupImportWizard({ showError, showNotice, inertTargets: backdrop });

// 閉じる経路は 3 つ（キャンセル・保存・Escape）ある。inert の解除と
// フォーカス復帰を取りこぼさないよう、必ずここを通す。
const closeSettings = () => {
  form.hidden = true;
  backdrop.forEach((element) => element.removeAttribute("inert"));
  $("settings").focus();
};
$("settings").onclick = async () => {
  try {
    await openSettings();
  } catch (e) {
    showError(e.message);
  }
};
$("settings-cancel").onclick = closeSettings;
form.onsubmit = async (event) => {
  event.preventDefault();
  try {
    await window.desktop.saveSettings({
      apiBaseUrl: $("api-base-url").value,
      shortcut: $("shortcut").value,
      model: $("model").value,
      temperature: Number($("temperature").value),
      maxTokens: Number($("max-tokens").value),
      restoreClipboard: $("restore").checked,
      launchAtLogin: $("login").checked,
      persona: $("persona").value,
      // 履歴オプトインのローカルキャッシュ。フォームが持たないので
      // 送り忘れると false に正規化され、サーバーの値とずれたまま残る。
      saveConversationHistory: saveHistoryOptIn,
    });
    closeSettings();
    showNotice("設定を保存しました。");
  } catch (e) {
    showError(e.message);
  }
};
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    // モーダルが開いていれば、まずそれだけ閉じる。
    if (!form.hidden) {
      closeSettings();
      return;
    }
    if (importWizard.isOpen()) {
      importWizard.close();
      return;
    }
    window.desktop.close();
  }
  // 設定シート表示中は背後の送信を走らせない。
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && form.hidden) {
    event.preventDefault();
    void ask();
  }
});
