// 質問履歴の一覧（Issue #199）。renderer.js の appendConversationItems が
// 作っていた <li><button class="conversation">… をそのまま React で描く。
import type { ConversationSummary } from "../../shared/types.js";

import { conversationMetaLine } from "../App.js";

interface Props {
  conversations: ConversationSummary[];
  // 表示中の詳細に data-current="true" を付ける（CSS が現在行を強調する）。
  viewingConversationId: string | null;
  onOpen: (id: string) => void;
}

export function ConversationList({ conversations, viewingConversationId, onOpen }: Props) {
  return (
    <ul className="conversations" id="conversations" aria-labelledby="history-title">
      {conversations.map((summary) => (
        <li key={summary.id}>
          <button
            type="button"
            className="conversation"
            data-id={summary.id}
            data-current={String(summary.id === viewingConversationId)}
            onClick={() => onOpen(summary.id)}
          >
            <span className="conversation-title">
              {summary.title ?? "（タイトルなし）"}
              {summary.complete === false && <span className="conversation-incomplete">中断</span>}
            </span>
            <span className="conversation-meta">{conversationMetaLine(summary)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
