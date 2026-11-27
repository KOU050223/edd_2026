// 回答カード。Markdown の描画は renderMarkdown（入力をエスケープ済み）の
// 結果を #answer に 1 か所だけ入れる。リンクのクリックは親が
// openExternalLink へ繋ぐ。
import type { MouseEvent } from "react";

interface Props {
  hidden: boolean;
  title: string;
  answerHtml: string;
  chips: string[];
  // 履歴の詳細を表示中は「履歴を削除」を出す。新しい回答では閉じる。
  viewingConversationId: string | null;
  deleteArmed: boolean;
  deleting: boolean;
  onDelete: () => void;
  onClose: () => void;
  onLinkClick: (event: MouseEvent<HTMLDivElement>) => void;
}

export function AnswerCard({
  hidden,
  title,
  answerHtml,
  chips,
  viewingConversationId,
  deleteArmed,
  deleting,
  onDelete,
  onClose,
  onLinkClick,
}: Props) {
  return (
    <div className="message" id="card" hidden={hidden}>
      <div className="message-head">
        <div className="avatar" aria-hidden="true">
          学
        </div>
        <h2 id="card-title">{title}</h2>
        <button
          id="history-delete"
          type="button"
          hidden={viewingConversationId === null}
          data-armed={String(deleteArmed)}
          disabled={deleting}
          onClick={onDelete}
        >
          {deleteArmed ? "もう一度押すと削除" : "履歴を削除"}
        </button>
        <button id="card-close" aria-label="回答を閉じる" onClick={onClose}>
          ×
        </button>
      </div>
      {/* renderMarkdown はタグや URL をエスケープした安全な HTML しか返さない
          （javascript:/data: はリンク化しない）ため、ここで差し込んでよい。
          renderer 内で dangerouslySetInnerHTML を使うのはこの 1 か所だけ。 */}
      <div
        id="answer"
        aria-live="polite"
        onClick={onLinkClick}
        dangerouslySetInnerHTML={{ __html: answerHtml }}
      />
      <div className="chips" id="chips" hidden={chips.length === 0}>
        {chips.map((chip) => (
          <span key={chip} className="chip">
            {chip}
          </span>
        ))}
      </div>
    </div>
  );
}
