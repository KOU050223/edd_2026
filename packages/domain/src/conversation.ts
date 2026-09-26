/**
 * 会話履歴のドメイン型とオプトイン文面（#204）。
 *
 * 設計の正本は docs/conversation-history.md。質問・回答・選択テキストの本文を
 * 保存するため、LearningEvent（メタデータのみ・習熟度の根拠）とは別の型にする。
 * VS Code にも Electron にも依存しない形にして、クライアント間で共有する。
 */

/** 会話を保存したクライアント。値は API の contract 側でも picklist として検査する。 */
export const CONVERSATION_ORIGINS = ["desktop", "vscode", "web", "cli"] as const;
export type ConversationOrigin = (typeof CONVERSATION_ORIGINS)[number];

/**
 * 会話内メッセージの役割。
 *
 * `context` は質問の対象となった選択テキストなどの文脈。
 * AI への入力である `ConversationTurn`（user/assistant のみ）と違い、
 * 履歴を見返すために文脈と時刻を保持する。
 */
export type ConversationMessageRole = "context" | "user" | "assistant";

export interface ConversationMessage {
  readonly role: ConversationMessageRole;
  readonly text: string;
  /** メッセージが確定した時刻（ISO 8601）。 */
  readonly at: string;
}

/**
 * 保存単位の会話。
 *
 * クライアントが採番した `id` で識別し、同じ `id` への upsert で会話が育つ。
 * Desktop の「選択 → 質問 → 回答」の1往復と、VS Code の1リクエストが
 * それぞれ1会話に対応する。
 */
export interface Conversation {
  /** クライアント採番の ID。VS Code は sessionId を流用する。 */
  readonly id: string;
  readonly origin: ConversationOrigin;
  /** どの端末からか（診断・端末別表示の材料）。 */
  readonly clientId?: string;
  /** 一覧表示用。質問の先頭行から派生させる。 */
  readonly title?: string;
  /** 選択テキストの言語識別子。 */
  readonly language?: string;
  /** 選択元のファイル名（取得できた場合のみ）。 */
  readonly fileName?: string;
  /** 最初の質問時刻（ISO 8601）。 */
  readonly occurredAt: string;
  /** 最後のメッセージ時刻（ISO 8601）。 */
  readonly updatedAt: string;
  /** 回答が最後まで届いたか。中断は false。 */
  readonly complete: boolean;
  readonly messages: ConversationMessage[];
}

/** 一覧に出すタイトルの上限。 */
export const CONVERSATION_TITLE_MAX_LENGTH = 80;

/**
 * 質問文から一覧用のタイトルを派生させる。
 *
 * 先頭の空でない行を取り、上限を超えたら末尾に省略記号を付けて切る。
 * 既定の質問文（「この選択テキストを〜」）はどの会話も同じ先頭になるため、
 * タイトルとして意味を持たない場合は呼び出し側が `undefined` を採用しない
 * 判断をしてよい。この関数は整形だけを担う。
 */
export function deriveConversationTitle(question: string): string | undefined {
  const firstLine = question
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return undefined;
  if (firstLine.length <= CONVERSATION_TITLE_MAX_LENGTH) return firstLine;
  return `${firstLine.slice(0, CONVERSATION_TITLE_MAX_LENGTH - 1)}…`;
}

/**
 * 「質問履歴の保存」を有効にするときに見せる文面。
 *
 * docs/data-privacy.md の要件（目的・保存期間・削除方法の明示）に対応する。
 * 文面はクライアント間で共有するためここに置く。片方だけ直さないこと。
 */
export const CONVERSATION_HISTORY_OPT_IN_NOTICE = [
  "「質問履歴の保存」を有効にすると、質問文・選択テキスト・AI の回答が",
  "学習記録サーバーに保存され、デスクトップアプリと Web から見返せるようになります。",
  "",
  "履歴はあなたが削除するまで残ります。履歴の一覧から1件ずつ、",
  "または設定画面から全件まとめて削除できます。",
  "「学習データを削除する」と退会でも履歴は消えます。",
  "",
  "無効のままでも、質問と AI への送信はこれまでどおり使えます",
  "（履歴が保存されないだけです）。",
].join("\n");
