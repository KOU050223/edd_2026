// 画面の配線。状態はここに集め、描画は components/ へ渡す
// （Issue #279 ステップ 4b。renderer.js の挙動をそのまま React へ移した）。
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";

import type { Conversation } from "@gakushu-sochi/domain";

import type { ConsentStatus, ConversationSummary, SettingsState } from "../shared/types.js";

import {
  AUTH_LABELS,
  authStatusLabel,
  shouldApplyAuthState,
  type AuthView,
} from "./auth-status.js";
import { AnswerCard } from "./components/AnswerCard.js";
import { ConversationList } from "./components/ConversationList.js";
import { ImportWizard } from "./components/ImportWizard.js";
import { SettingsSheet } from "./components/SettingsSheet.js";
import { useDesktopEvent } from "./hooks/use-desktop-event.js";
import { useLatestRequest } from "./hooks/use-latest-request.js";
import { renderMarkdown } from "./markdown.js";

interface Notification {
  text: string;
  tone: "error" | "notice";
}

const ORIGIN_LABELS: Record<string, string> = {
  desktop: "デスクトップ",
  vscode: "VS Code",
  web: "Web",
  cli: "CLI",
};

export const conversationMetaLine = (summary: ConversationSummary): string =>
  [
    new Date(summary.occurredAt).toLocaleString("ja-JP"),
    ORIGIN_LABELS[summary.origin] ?? summary.origin,
    summary.fileName,
  ]
    .filter(Boolean)
    .join("・");

export function App() {
  // #error は失敗と成功の両方を出す共有チャネル。CSS が data-tone で色を出し分ける。
  const [notification, setNotification] = useState<Notification>({ text: "", tone: "error" });
  const showError = useCallback(
    (message = "") => setNotification({ text: message, tone: "error" }),
    [],
  );
  const showNotice = useCallback(
    (message = "") => setNotification({ text: message, tone: "notice" }),
    [],
  );

  // ---------------------------------------------------------------------------
  // 質問履歴（Issue #199）。左サイドバーは Learning Map ではなく履歴を出す。
  // 一覧は GET /v1/conversations の要約（本文なし）で、クリックした行だけ
  // 詳細を取り、選択テキストと回答カードへ写す。本文は端末へ永続化しない。
  // ---------------------------------------------------------------------------
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationsNote, setConversationsNote] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // 入口で弾く同期ガード（RULE-007）。state はレンダー後まで反映されないため、
  // 同一ティック内の二度押しは ref で止める。disabled は見た目でしかない。
  const loadingMoreRef = useRef(false);
  // 再読み込みが重なったとき、古い応答で新しい表示を上書きしない（RULE-005）。
  const conversationsRequest = useLatestRequest();
  const detailRequest = useLatestRequest();

  // 詳細表示中の会話 ID。「履歴を削除」ボタンの対象になる。
  const [viewingConversationId, setViewingConversationId] = useState<string | null>(null);
  // 削除の応答を待つ間に別の履歴を開きうる。完了時に「今表示している ID」と
  // 比べるため、コミット後に同期しておく（レンダー中に ref は書かない）。
  const viewingConversationIdRef = useRef<string | null>(null);
  useEffect(() => {
    viewingConversationIdRef.current = viewingConversationId;
  }, [viewingConversationId]);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const deleteArmedRef = useRef(false);
  const [deletingConversation, setDeletingConversation] = useState(false);
  const deletingConversationRef = useRef(false);
  const deleteArmTimerRef = useRef<number | undefined>(undefined);

  const resetHistoryDelete = useCallback(() => {
    if (deleteArmTimerRef.current !== undefined) window.clearTimeout(deleteArmTimerRef.current);
    deleteArmTimerRef.current = undefined;
    deleteArmedRef.current = false;
    setDeleteArmed(false);
  }, []);

  // ---------------------------------------------------------------------------
  // 選択テキストと回答カード。
  // 選択テキストは #selection が唯一の保持先。#code は表示用の写し。
  // ---------------------------------------------------------------------------
  const [selectionText, setSelectionText] = useState("");
  const [cardHidden, setCardHidden] = useState(true);
  const [cardTitle, setCardTitle] = useState("回答");
  const [chips, setChips] = useState<string[]>([]);
  const [answerHtml, setAnswerHtml] = useState("");
  const [isAsking, setIsAsking] = useState(false);
  const isAskingRef = useRef(false);
  // delta を連結した生の Markdown。描画は rAF で 1 フレーム 1 回にまとめる
  // （delta ごとに全文を描き直すと応答長の二乗で重くなる）。
  const answerMarkdownRef = useRef("");
  const answerFrameRef = useRef<number | null>(null);
  const followScrollRef = useRef(false);

  const questionRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);

  const resetCard = useCallback(() => {
    // 新しい選択・質問・履歴の描画・ログアウトでここを通る。飛行中の
    // 詳細取得があとから届いて古い履歴で上書きしないよう、先に無効化する。
    detailRequest.begin();
    setCardTitle("回答");
    answerMarkdownRef.current = "";
    setAnswerHtml("");
    setChips([]);
    // 履歴の詳細表示は新しい選択・質問で切り替わるため、削除ボタンと対象を閉じる。
    setViewingConversationId(null);
    resetHistoryDelete();
  }, [detailRequest, resetHistoryDelete]);

  const loadConversations = useCallback(async () => {
    const generation = conversationsRequest.begin();
    try {
      const page = await window.desktop.listConversations();
      if (!conversationsRequest.isLatest(generation)) return;
      setNextCursor(page.nextCursor);
      setConversations(page.conversations);
      setConversationsNote(page.conversations.length === 0 ? "まだ質問履歴がありません。" : "");
    } catch (e) {
      if (!conversationsRequest.isLatest(generation)) return;
      // 一覧が出せなくても質問はできるので、致命傷にはしない。
      // 未ログインの場合も getAccessToken の文言がそのまま案内になる。
      setConversations([]);
      setNextCursor(null);
      setConversationsNote(
        `質問履歴を読み込めませんでした: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }, [conversationsRequest]);

  const renderCode = useCallback((text: string) => setSelectionText(text), []);

  const loadMoreConversations = useCallback(async () => {
    // 入口で弾く（RULE-007）。disabled は見た目でしかない。
    const cursor = nextCursor;
    if (loadingMoreRef.current || cursor === null) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const generation = conversationsRequest.current();
    try {
      const page = await window.desktop.listConversations(cursor);
      // 読み込み中に一覧が読み直されたら、続きは新しい一覧に対して取り直す。
      if (!conversationsRequest.isLatest(generation)) return;
      setNextCursor(page.nextCursor);
      setConversations((previous) => [...previous, ...page.conversations]);
    } catch (e) {
      showError(
        `質問履歴の続きを読み込めませんでした: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [conversationsRequest, nextCursor, showError]);

  const renderConversation = useCallback(
    (conversation: Conversation) => {
      const context = conversation.messages.find((message) => message.role === "context");
      const user = conversation.messages.find((message) => message.role === "user");
      const assistant = [...conversation.messages]
        .reverse()
        .find((message) => message.role === "assistant");
      if (context !== undefined) renderCode(context.text);
      resetCard();
      setCardTitle(conversation.title ?? user?.text ?? "回答");
      answerMarkdownRef.current = assistant?.text ?? "";
      setAnswerHtml(renderMarkdown(answerMarkdownRef.current));
      if (!conversation.complete) {
        setChips(["回答は途中で中断されました"]);
      }
      setCardHidden(false);
      if (threadRef.current !== null) threadRef.current.scrollTop = 0;
    },
    [renderCode, resetCard],
  );

  const openConversation = useCallback(
    async (id: string) => {
      // 回答のストリーム中は開かない。保存済みの回答へ生の delta が
      // 追記されて2つの会話が混ざるため（answerMarkdown は共有している）。
      if (isAskingRef.current) {
        showNotice("回答を生成している間は履歴を開けません。");
        return;
      }
      const generation = detailRequest.begin();
      try {
        const conversation = await window.desktop.getConversation(id);
        if (!detailRequest.isLatest(generation)) return;
        // resetCard が viewingConversationId を null に戻すため、詳細を描いてから立てる。
        renderConversation(conversation);
        setViewingConversationId(id);
      } catch (e) {
        if (!detailRequest.isLatest(generation)) return;
        showError(`履歴を開けませんでした: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [detailRequest, renderConversation, showError, showNotice],
  );

  const deleteConversation = useCallback(async () => {
    if (viewingConversationId === null || deletingConversationRef.current) return;
    // 不可逆操作なので二段階にする。一定時間で自動解除する。
    if (!deleteArmedRef.current) {
      deleteArmedRef.current = true;
      setDeleteArmed(true);
      deleteArmTimerRef.current = window.setTimeout(resetHistoryDelete, 5000);
      return;
    }
    window.clearTimeout(deleteArmTimerRef.current);
    deleteArmTimerRef.current = undefined;
    // 応答を待つ間に別の履歴を開きうる。完了時に画面を消すのは
    // 表示が変わっていないときだけにするため、対象 ID を捕獲しておく。
    const deletingId = viewingConversationId;
    deletingConversationRef.current = true;
    setDeletingConversation(true);
    try {
      await window.desktop.deleteConversation(deletingId);
      showNotice("履歴を削除しました。");
      void loadConversations();
      if (viewingConversationIdRef.current === deletingId) {
        setViewingConversationId(null);
        setCardHidden(true);
        resetHistoryDelete();
      }
    } catch (e) {
      // 失敗の通知は共有チャネルへ出すが、別の履歴を開いているなら
      // その削除ボタンの状態までは触らない。
      if (viewingConversationIdRef.current === deletingId) resetHistoryDelete();
      showError(`履歴を削除できませんでした: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      deletingConversationRef.current = false;
      setDeletingConversation(false);
    }
  }, [viewingConversationId, loadConversations, resetHistoryDelete, showError, showNotice]);

  // ---------------------------------------------------------------------------
  // ログイン／ログアウト。進行中かどうかは disabled ではなくこの状態で判断する
  // （.agents/rules/rules.md RULE-007）。
  // ---------------------------------------------------------------------------
  const [authView, setAuthView] = useState<AuthView>({
    loggingIn: false,
    loggingOut: false,
    hasRefreshToken: false,
  });
  // ガードと auth:state の判定はコミットを待たずに効かせるため、
  // ハンドラ内で同期的に更新する正本を別に持つ。
  const authViewRef = useRef(authView);
  const updateAuthView = useCallback((patch: Partial<AuthView>) => {
    authViewRef.current = { ...authViewRef.current, ...patch };
    setAuthView(authViewRef.current);
  }, []);
  // ログイン失敗時の表示は authStatusLabel の外側にある（失敗ラベルは
  // 次に状態が更新されるまで残る）。
  const [authFailed, setAuthFailed] = useState(false);
  const authStatusText = authFailed ? AUTH_LABELS.failed : authStatusLabel(authView);

  const login = useCallback(async () => {
    // 入口で弾く（RULE-007）。disabled は見た目でしかない。
    if (authViewRef.current.loggingIn || authViewRef.current.loggingOut) return;
    updateAuthView({ loggingIn: true });
    setAuthFailed(false);
    try {
      await window.desktop.login();
      updateAuthView({ hasRefreshToken: true });
      // ログイン成功は auth:state で通知されないため、ここで履歴を読み直す。
      void loadConversations();
    } catch (e) {
      setAuthFailed(true);
      showError(e instanceof Error ? e.message : String(e));
    } finally {
      // 失敗しても必ず戻す。try の末尾に置くとボタンが固まったままになる。
      updateAuthView({ loggingIn: false });
    }
  }, [updateAuthView, loadConversations, showError]);

  const logout = useCallback(async () => {
    // 入口で弾く（RULE-007）。disabled は見た目でしかない。
    if (authViewRef.current.loggingOut || authViewRef.current.loggingIn) return;
    updateAuthView({ loggingOut: true });
    try {
      await window.desktop.logout();
      updateAuthView({ hasRefreshToken: false });
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    } finally {
      updateAuthView({ loggingOut: false });
    }
  }, [updateAuthView, showError]);

  const setAuthState = useCallback(
    (hasRefreshToken: boolean) => {
      updateAuthView({ hasRefreshToken });
      setAuthFailed(false);
    },
    [updateAuthView],
  );

  // ---------------------------------------------------------------------------
  // main → renderer のイベント。
  // ---------------------------------------------------------------------------
  useDesktopEvent(window.desktop.onAuthState, ({ hasRefreshToken }) => {
    // ログイン中に届いた通知は取り込まない。走っているログインについて画面が嘘をつく。
    if (!shouldApplyAuthState(authViewRef.current)) return;
    setAuthState(hasRefreshToken);
    if (!hasRefreshToken) {
      // ログアウト後に前のアカウントの履歴が画面へ残らないよう、表示中の
      // 詳細と選択テキストも消す。飛行中の詳細取得は resetCard の
      // 世代更新で無効になる。
      renderCode("");
      resetCard();
      setCardHidden(true);
    }
    // ログイン・ログアウトで履歴の見え方が変わるので読み直す。
    void loadConversations();
  });

  useDesktopEvent(window.desktop.onSelection, ({ selection: text, error: message }) => {
    renderCode(text);
    if (message) showError(message);
    else showNotice();
    resetCard();
    setCardHidden(true);
    questionRef.current?.focus();
    // ショートカットで開くたびに履歴を最新にする。
    void loadConversations();
  });

  useDesktopEvent(window.desktop.onDelta, (delta) => {
    // 既に最下部を見ているときだけ、新しい行を追って自動スクロールする。
    const thread = threadRef.current;
    if (thread !== null) {
      followScrollRef.current = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 48;
    }
    answerMarkdownRef.current += delta;
    if (answerFrameRef.current === null) {
      answerFrameRef.current = requestAnimationFrame(() => {
        answerFrameRef.current = null;
        setAnswerHtml(renderMarkdown(answerMarkdownRef.current));
        const current = threadRef.current;
        if (followScrollRef.current && current !== null) {
          current.scrollTop = current.scrollHeight;
        }
      });
    }
  });

  // 履歴の保存失敗は回答の表示を止めないが、黙っても落とさない（RULE-004）。
  useDesktopEvent(window.desktop.onHistorySaveFailed, (message) => showError(message));

  const answerLinkClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const link = (event.target as HTMLElement).closest("a");
      if (link === null) return;
      event.preventDefault();
      void window.desktop.openExternalLink(link.href).catch((e: unknown) => {
        showError(`リンクを開けませんでした: ${e instanceof Error ? e.message : String(e)}`);
      });
    },
    [showError],
  );

  // ---------------------------------------------------------------------------
  // 質問の送信。
  // ---------------------------------------------------------------------------
  const [question, setQuestion] = useState("");
  // 「停止」を押したかどうか。main 側の中断はエラーではなく正常終了で返るので、
  // キャンセル由来かどうかをここで記憶して通知の文面に使う。
  const cancelRequestedRef = useRef(false);

  const cancelAsk = useCallback(async () => {
    if (!isAskingRef.current) return;
    cancelRequestedRef.current = true;
    try {
      await window.desktop.cancelAnswer();
    } catch (e) {
      cancelRequestedRef.current = false;
      showError(`回答を停止できませんでした: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [showError]);

  const ask = useCallback(async () => {
    if (isAskingRef.current) return;
    isAskingRef.current = true;
    cancelRequestedRef.current = false;
    setIsAsking(true);
    try {
      showNotice();
      resetCard();
      const asked = question.trim();
      setCardTitle(asked || "回答");
      setCardHidden(false);
      await window.desktop.ask(selectionText, question);
      if (cancelRequestedRef.current) {
        showNotice("回答を停止しました");
      }
      // 履歴保存が有効なら新しい会話が保存されている。一覧を読み直す。
      void loadConversations();
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    } finally {
      isAskingRef.current = false;
      setIsAsking(false);
    }
  }, [loadConversations, question, selectionText, resetCard, showError, showNotice]);
  // keydown のリスナーを打ち直しごとに張り替えないよう、最新の ask を
  // コミット後に同期する（レンダー中に ref は書かない）。
  const askRef = useRef(ask);
  useEffect(() => {
    askRef.current = ask;
  });

  const retrySelection = useCallback(async () => {
    try {
      await window.desktop.retrySelection();
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    }
  }, [showError]);

  // ---------------------------------------------------------------------------
  // 設定シートと履歴インポート wizard（モーダル）。
  // 開いている間は背後（titlebar・workspace）を inert にする。
  // ---------------------------------------------------------------------------
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitial, setSettingsInitial] = useState<{
    settings: SettingsState;
    consent: ConsentStatus;
  } | null>(null);
  // 開くたびに増やす key。SettingsSheet が再マウントされ、useState の初期値で
  // フォームが初期化される（effect でフォーム状態を書き換えないため）。
  const [settingsSession, setSettingsSession] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  const modalOpen = settingsOpen || importOpen;

  const openSettings = useCallback(async () => {
    const settings = await window.desktop.getSettings();
    const consent = await window.desktop.getConsentStatus();
    setAuthState(settings.hasRefreshToken);
    setSettingsInitial({ settings, consent });
    setSettingsSession((session) => session + 1);
    setSettingsOpen(true);
  }, [setAuthState]);

  // 閉じる経路は 3 つ（キャンセル・保存・Escape）ある。inert の解除と
  // フォーカス復帰を取りこぼさないよう、必ずここを通す。
  // inert は再レンダーで外れるため、フォーカスはコミット後の effect で戻す
  // （inert の中へはフォーカスできない）。
  const restoreSettingsFocusRef = useRef(false);
  const closeSettings = useCallback(() => {
    restoreSettingsFocusRef.current = true;
    setSettingsOpen(false);
  }, []);
  useEffect(() => {
    if (settingsOpen || !restoreSettingsFocusRef.current) return;
    restoreSettingsFocusRef.current = false;
    settingsButtonRef.current?.focus();
  }, [settingsOpen]);

  const clickSettings = useCallback(async () => {
    try {
      await openSettings();
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    }
  }, [openSettings, showError]);

  // ---------------------------------------------------------------------------
  // 起動時の一覧読み込みとキーボード。
  // ---------------------------------------------------------------------------
  useEffect(() => {
    void (async () => {
      await loadConversations();
    })();
  }, [loadConversations]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // モーダルが開いていれば、まずそれだけ閉じる。
        if (settingsOpen) {
          closeSettings();
          return;
        }
        if (importOpen) {
          setImportOpen(false);
          return;
        }
        void window.desktop.close();
      }
      // モーダル表示中は背後の送信を走らせない。
      if (
        event.key === "Enter" &&
        (event.metaKey || event.ctrlKey) &&
        !settingsOpen &&
        !importOpen
      ) {
        event.preventDefault();
        void askRef.current();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [settingsOpen, importOpen, closeSettings]);

  const [selectionFirst, ...selectionRest] = selectionText.split("\n");

  return (
    <main>
      <header id="titlebar" inert={modalOpen}>
        <div className="brand">
          <h1>学習装置</h1>
          <span className="brand-latin">Gakushu Sochi</span>
        </div>
        <div className="win-actions">
          <button id="close" aria-label="閉じる" onClick={() => void window.desktop.close()}>
            ×
          </button>
        </div>
      </header>

      <div className="workspace" id="workspace" inert={modalOpen}>
        <aside className="sidebar">
          <div className="kicker" id="history-title">
            質問履歴
          </div>
          <p className="sidebar-note" id="conversations-note" hidden={conversationsNote === ""}>
            {conversationsNote}
          </p>
          <ConversationList
            conversations={conversations}
            viewingConversationId={viewingConversationId}
            onOpen={(id) => void openConversation(id)}
          />
          <button
            id="conversations-more"
            hidden={nextCursor === null}
            disabled={loadingMore}
            onClick={() => void loadMoreConversations()}
          >
            さらに読み込む
          </button>
          <div className="sidebar-foot">
            <button id="import-open" onClick={() => setImportOpen(true)}>
              履歴から地図を作る
            </button>
            <button id="settings" ref={settingsButtonRef} onClick={() => void clickSettings()}>
              設定
            </button>
          </div>
        </aside>

        <section className="stage">
          {/* 会話領域: ここだけがスクロールする */}
          <div className="thread" id="thread" ref={threadRef}>
            <p id="error" role="alert" data-tone={notification.tone}>
              {notification.text}
            </p>

            <div className="code-wrap">
              <div className="code-head">
                <span className="kicker">選択テキスト</span>
                <button id="retry" onClick={() => void retrySelection()}>
                  選択を再取得
                </button>
              </div>
              {/* 表示用のコードブロック。#selection は値の唯一の保持先として残す。
                  冒頭行（宣言部）だけ帯を敷いて、どこを聞いているかを示す。 */}
              <pre id="code" className="code" aria-live="polite">
                <span className="hl">{selectionFirst ?? ""}</span>
                {selectionRest.length > 0 ? `\n${selectionRest.join("\n")}` : ""}
              </pre>
              <textarea id="selection" hidden readOnly aria-hidden="true" value={selectionText} />
            </div>

            {/* 回答: 縦に伸びるアシスタントの吹き出し */}
            <AnswerCard
              hidden={cardHidden}
              title={cardTitle}
              answerHtml={answerHtml}
              chips={chips}
              viewingConversationId={viewingConversationId}
              deleteArmed={deleteArmed}
              deleting={deletingConversation}
              onDelete={() => void deleteConversation()}
              onClose={() => setCardHidden(true)}
              onLinkClick={answerLinkClick}
            />
          </div>

          {/* 入力欄: 下に固定 */}
          <div className="composer">
            <textarea
              id="question"
              rows={2}
              placeholder="何を知りたいですか？"
              aria-label="質問"
              ref={questionRef}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
            />
            <div className="composer-actions">
              {isAsking ? (
                <button id="cancel" onClick={() => void cancelAsk()}>
                  停止
                </button>
              ) : (
                <button id="send" onClick={() => void ask()}>
                  送信
                </button>
              )}
            </div>
          </div>
        </section>
      </div>

      <SettingsSheet
        key={settingsSession}
        open={settingsOpen}
        initial={settingsInitial}
        authView={authView}
        authStatusText={authStatusText}
        onLogin={() => void login()}
        onLogout={() => void logout()}
        onClose={closeSettings}
        showError={showError}
        showNotice={showNotice}
      />

      {/* 履歴インポート wizard（Issue #157）。inert 対象は設定シートと同じ。 */}
      <ImportWizard
        open={importOpen}
        onClose={() => setImportOpen(false)}
        showNotice={showNotice}
      />
    </main>
  );
}
