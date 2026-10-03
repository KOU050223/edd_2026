import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";
import type { ConversationMessageRole } from "@gakushu-sochi/domain";
import { ApiError, createSubmitGuard } from "../../api.js";
import { deleteConversation, fetchConversation, originLabel } from "../../conversations.js";
import { toErrorText } from "../../errors.js";
import { takeLoginRetry } from "../../session.js";

const ROLE_LABEL: Record<ConversationMessageRole, string> = {
  context: "選択テキスト",
  user: "質問",
  assistant: "回答",
};

/**
 * 1会話の詳細（Issue #206）。一覧の `ConversationSummary` には本文が無いので、
 * ここでだけ `GET /v1/conversations/:id` を取る。
 */
function ConversationDetail() {
  const { conversation } = Route.useLoaderData();
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
    return { conversation };
  },
  component: ConversationDetail,
});
