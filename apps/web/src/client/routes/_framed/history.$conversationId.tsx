import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";
import type { ConversationMessageRole } from "@gakushu-sochi/domain";
import { ApiError, createSubmitGuard } from "../../api.js";
import {
  eventTypeLabel,
  fetchConversationLearningEvents,
  formatObjectiveDelta,
  groupChangesByConcept,
  type ConversationLearningEvent,
} from "../../conversation-learning.js";
import { deleteConversation, fetchConversation, originLabel } from "../../conversations.js";
import { toErrorText } from "../../errors.js";
import { takeLoginRetry } from "../../session.js";

const ROLE_LABEL: Record<ConversationMessageRole, string> = {
  context: "選択テキスト",
  user: "質問",
  assistant: "回答",
};

type LearningResult =
  { ok: true; events: ConversationLearningEvent[] } | { ok: false; message: string };

/**
 * この会話で動いた「理解すること」（Web/15 #233）。
 * 項目に触れたイベントだけが届く（answer_viewed や項目を持たない Concept は API が除く）。
 */
function LearningSection({ learning }: { learning: LearningResult }) {
  return (
    <section className="history-learning">
      <h2>この会話で記録した学習</h2>
      {!learning.ok ? (
        <p className="error-text" role="alert">
          学習の記録を読み込めませんでした：{learning.message}
        </p>
      ) : learning.events.length === 0 ? (
        <p className="muted">この会話で理解度が動いた項目はありません。</p>
      ) : (
        <ul className="history-learning-events">
          {learning.events.map((event) => (
            <li key={event.id}>
              <div className="msg-head">
                <strong>{eventTypeLabel(event.type)}</strong>
                <time dateTime={event.occurredAt} className="muted">
                  {new Date(event.occurredAt).toLocaleString("ja-JP")}
                </time>
              </div>
              {groupChangesByConcept(event.changes).map((group) => (
                <div key={group.conceptId} className="history-learning-concept">
                  <span className="history-learning-concept-label">{group.conceptLabel}</span>
                  <ul>
                    {group.changes.map((change) => (
                      <li key={change.objectiveId}>
                        {change.objectiveLabel}{" "}
                        <span className="history-learning-delta">
                          {formatObjectiveDelta(change)}
                        </span>{" "}
                        <span className="muted">
                          （{Math.round(change.before * 100)}% → {Math.round(change.after * 100)}
                          %）
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * 1会話の詳細（Issue #206）。一覧の `ConversationSummary` には本文が無いので、
 * ここでだけ `GET /v1/conversations/:id` を取る。
 */
function ConversationDetail() {
  const { conversation, learning } = Route.useLoaderData();
  const router = useRouter();
  const navigate = useNavigate();
  const submitGuard = useRef(createSubmitGuard());
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();

  const runDelete = () => {
    if (submitGuard.current.isRunning("delete")) return;
    setDeleteError(undefined);
    setDeleting(true);
    void submitGuard.current
      .run("delete", async () => {
        try {
          await deleteConversation(fetch, conversation.id);
          // **一覧の loader キャッシュも捨てる。** 消した会話が一覧へ
          // 残ったままにしない（RULE-005）。
          await router.invalidate();
          await navigate({ to: "/history" });
        } catch (value: unknown) {
          if (value instanceof ApiError && value.kind === "session_expired") {
            window.location.href = "/login";
            return;
          }
          setDeleteError(toErrorText(value));
        }
      })
      .finally(() => {
        setDeleting(false);
      });
  };

  return (
    <section className="history detail-page">
      <p>
        <Link to="/history" className="link">
          ← 履歴へ戻る
        </Link>
      </p>
      <h1>{conversation.title ?? "（タイトルなし）"}</h1>
      <dl className="history-meta">
        <dt>保存元</dt>
        <dd>
          {originLabel(conversation.origin)}
          {conversation.clientId ? `（${conversation.clientId}）` : ""}
        </dd>
        <dt>質問日時</dt>
        <dd>{new Date(conversation.occurredAt).toLocaleString("ja-JP")}</dd>
        {conversation.language && (
          <>
            <dt>言語</dt>
            <dd>{conversation.language}</dd>
          </>
        )}
        {conversation.fileName && (
          <>
            <dt>ファイル</dt>
            <dd>{conversation.fileName}</dd>
          </>
        )}
        {!conversation.complete && (
          <>
            <dt>状態</dt>
            <dd>回答は途中で中断されました</dd>
          </>
        )}
      </dl>

      <LearningSection learning={learning} />

      <div className="history-messages">
        {conversation.messages.map((message, index) => (
          <article key={index} className={`history-message ${message.role}`}>
            {/* <header> はグローバルにページ帯のスタイルが当たるので div で書く。 */}
            <div className="msg-head">
              <strong>{ROLE_LABEL[message.role]}</strong>
              <time dateTime={message.at} className="muted">
                {new Date(message.at).toLocaleString("ja-JP")}
              </time>
            </div>
            <pre>{message.text}</pre>
          </article>
        ))}
      </div>

      {confirming ? (
        <div className="confirm-delete">
          <p>
            <strong>この履歴を削除しますか？</strong>
            この操作は取り消せません。
          </p>
          <div className="actions">
            <button type="button" className="danger" disabled={deleting} onClick={runDelete}>
              {deleting ? "削除中…" : "削除する"}
            </button>
            <button type="button" disabled={deleting} onClick={() => setConfirming(false)}>
              やめる
            </button>
          </div>
        </div>
      ) : (
        <div className="actions">
          <button type="button" className="danger" onClick={() => setConfirming(true)}>
            この履歴を削除する
          </button>
        </div>
      )}
      {deleteError && (
        <p className="error-text" role="alert">
          履歴を削除できませんでした：{deleteError}
        </p>
      )}
    </section>
  );
}

export const Route = createFileRoute("/_framed/history/$conversationId")({
  // 本文を30秒キャッシュに置かない。削除済みの会話や古い内容を
  // 残して見せないため、詳細は訪れるたびに取り直す。
  staleTime: 0,
  loader: async ({ params }) => {
    const conversation = await fetchConversation(fetch, takeLoginRetry(), params.conversationId);
    // ログイン直後の再試行は会話の取得で使い切っている（セッションは張れている）ので 0 回。
    // 学習の表示は補足なので、取れなくても会話本文は見せ、失敗は節の中で伝える（RULE-004）。
    const learning: LearningResult = await fetchConversationLearningEvents(
      fetch,
      0,
      params.conversationId,
    ).then(
      (events) => ({ ok: true, events }),
      (error: unknown) => ({ ok: false, message: toErrorText(error) }),
    );
    return { conversation, learning };
  },
  component: ConversationDetail,
});
