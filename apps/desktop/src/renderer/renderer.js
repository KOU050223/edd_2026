import { renderMarkdown } from "./markdown.js";
import { AUTH_LABELS, authStatusLabel, shouldApplyAuthState } from "./auth-status.js";

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

// Concept 一覧は packages/domain が正典（main の concepts:list 経由）。
// 習熟度はまだ API から取れないため、全件 "unobserved" で描く。
// 習熟度が取れるようになったら status をそこから埋める。
const renderConcepts = (concepts) => {
  const list = $("concepts");
  list.replaceChildren(
    ...concepts.map((concept) => {
      const item = document.createElement("li");
      item.className = "concept";
      item.dataset.status = concept.status ?? "unobserved";
      const dot = document.createElement("span");
      dot.className = "dot";
      const label = document.createElement("span");
      label.textContent = concept.label;
      item.append(dot, label);
      return item;
    }),
  );
};

const loadConcepts = async () => {
  try {
    renderConcepts(await window.desktop.getConcepts());
  } catch (e) {
    // 一覧が出せなくても質問はできるので、致命傷にはしない。
    showError(`Learning Map を読み込めませんでした: ${e instanceof Error ? e.message : String(e)}`);
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

void loadConcepts();

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
});

window.desktop.onSelection(({ selection: text, error: message }) => {
  renderCode(text);
  if (message) showError(message);
  else showNotice();
  resetCard();
  card.hidden = true;
  question.focus();
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
// 「もっと自分で考えたい」は Hint モードが入るまで質問欄へ促すだけに留める。
$("think").onclick = () => {
  question.focus();
  showNotice("自分の言葉で考えを書いてみてください。");
};

const ask = async () => {
  if (isAsking) return;
  isAsking = true;
  send.disabled = true;
  try {
    showNotice();
    answerMarkdown = "";
    answer.replaceChildren();
    chips.hidden = true;
    const asked = question.value.trim();
    cardTitle.textContent = asked || "回答";
    card.hidden = false;
    await window.desktop.ask(selection.value, question.value);
  } catch (e) {
    showError(e.message);
  } finally {
    isAsking = false;
    send.disabled = false;
  }
};
send.onclick = ask;

const openSettings = async () => {
  const s = await window.desktop.getSettings();
  ["api-base-url", "shortcut", "model", "temperature", "max-tokens", "persona"].forEach((id) => {
    $(id).value = s[id === "api-base-url" ? "apiBaseUrl" : id === "max-tokens" ? "maxTokens" : id];
  });
  $("restore").checked = s.restoreClipboard;
  $("login").checked = s.launchAtLogin;
  setAuthState(s.hasRefreshToken);
  form.hidden = false;
  // モーダルの背後へ Tab で抜けさせない（inert は form の祖先には置けないため兄弟に置く）。
  backdrop.forEach((element) => element.setAttribute("inert", ""));
  $("api-base-url").focus();
};

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
    });
    closeSettings();
    showNotice("設定を保存しました。");
  } catch (e) {
    showError(e.message);
  }
};
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    // 設定シートが開いていれば、まずそれだけ閉じる。
    if (!form.hidden) {
      closeSettings();
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
