import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ApiError, createSubmitGuard, requestJson } from "../../api.js";
import { fetchConversations, originLabel, type ConversationSummary } from "../../conversations.js";
import { isUserSettings, type UserSettings } from "../../../shared/settings.js";
import { toErrorText } from "../../errors.js";
import { takeLoginRetry } from "../../session.js";

function summaryLine(summary: ConversationSummary): string {
  return [
    new Date(summary.occurredAt).toLocaleString("ja-JP"),
    originLabel(summary.origin),
    summary.language,
    summary.fileName,
  ]
    .filter((part): part is string => typeof part === "string")
    .join("・");
}

/**
 * 質問履歴の一覧（Issue #206）。
 *
 * 一覧が返すのはメタデータだけで、本文は詳細 `/history/$conversationId` で
 * 取る。サーバーは `updatedAt` 降順で返す。
 */
function HistoryList() {
  const { page, savingEnabled } = Route.useLoaderData();
  const submitGuard = useRef(createSubmitGuard());
  // 続きのページだけを state に持つ。先頭ページは loader の値をそのまま使うので、
  // `router.invalidate()` で読み直された一覧が古い表示へ混ざらない（RULE-005）。
  const [appended, setAppended] = useState<ConversationSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(page.nextCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string>();

  // loader が読み直されたら続きのページは捨てて、先頭へ揃える。
  useEffect(() => {
    setAppended([]);
    setCursor(page.nextCursor);
    setMoreError(undefined);
  }, [page]);

  const loadMore = () => {
    if (cursor === null) return;
    // 入口で弾く（RULE-007）。`disabled` は見た目でしかない。
    if (submitGuard.current.isRunning("more")) return;
    setMoreError(undefined);
    setLoadingMore(true);
    const requested = cursor;
    void submitGuard.current
      .run("more", async () => {
        try {
          const next = await fetchConversations(fetch, 0, requested);
          setAppended((current) => [...current, ...next.conversations]);
          setCursor(next.nextCursor);
        } catch (value: unknown) {
          if (value instanceof ApiError && value.kind === "session_expired") {
            window.location.href = "/login";
            return;
          }
          setMoreError(toErrorText(value));
        }
      })
      .finally(() => {
        setLoadingMore(false);
      });
  };

  const all = [...page.conversations, ...appended];
  return (
    <section className="history">
      <h1>質問履歴</h1>
      {!savingEnabled && (
        <p className="hint">
          「質問履歴の保存」は現在無効です。新しい質問は履歴に残りません。 有効にするには
          <Link to="/settings">設定の「一般」</Link>を開いてください。
        </p>
      )}
      {all.length === 0 ? (
        <p className="message">まだ質問履歴がありません。</p>
      ) : (
        <ul className="history-list">
          {all.map((summary) => (
            <li key={summary.id}>
              <Link to="/history/$conversationId" params={{ conversationId: summary.id }}>
                <strong>
                  {summary.title ?? "（タイトルなし）"}
                  {summary.complete === false && <span className="incomplete">中断</span>}
                </strong>
                <span className="muted">{summaryLine(summary)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {cursor !== null && (
        <div className="actions">
          <button type="button" disabled={loadingMore} onClick={loadMore}>
            {loadingMore ? "読み込み中…" : "さらに読み込む"}
          </button>
        </div>
      )}
      {moreError && (
        <p className="error-text" role="alert">
          続きを読み込めませんでした：{moreError}
        </p>
      )}
    </section>
  );
}

export const Route = createFileRoute("/_framed/history/")({
  loader: async () => {
    const retry = takeLoginRetry();
    const [page, settings] = await Promise.all([
      fetchConversations(fetch, retry),
      requestJson<UserSettings>("/api/v1/user-settings", fetch, retry),
    ]);
    // 2xx でも中身が契約どおりでなければ失敗として扱う（RULE-004）。
    if (!isUserSettings(settings)) throw new ApiError("unavailable");
    return { page, savingEnabled: settings.saveConversationHistory };
  },
  component: HistoryList,
});
