import { createHash } from "node:crypto";

import type { RawConversation } from "@gakushu-sochi/domain";

/**
 * 外部履歴の前処理。
 *
 * API サーバへ渡る前に、会話本文から個人情報・トークン・ローカルパスを
 * 除去し、重複を潰す。ここで落としたものは二度と復元できないので、
 * 「何種類を落としたか」を必ず返して呼び出し側に報告させる
 * （RULE-004: 黙って捨てない）。
 */

/** 1会話あたりの本文上限。API 側の excerpt と揃え、超過分は先頭を残す。 */
export const MAX_BODY_CHARS = 4_000;

/** 除去したものの種類。UI 上の「除去: N件」表示や監査のために種類名だけを数える。 */
export type SanitizedKind = "email" | "token" | "local-path" | "truncated";

export interface SanitizedConversation {
  conversation: RawConversation;
  removedKinds: SanitizedKind[];
}

const PATTERNS: ReadonlyArray<{ kind: SanitizedKind; pattern: RegExp; replacement: string }> = [
  { kind: "email", pattern: /[\w.+-]+@[\w-]+\.[\w.-]+/g, replacement: "<email>" },
  {
    kind: "token",
    // sk-* / ghp_* / AWS AKIA / Bearer など、見た目で分かる鍵だけを潰す。
    pattern:
      /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[opsu]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._~+/-]{20,})\b/g,
    replacement: "<token>",
  },
  {
    kind: "local-path",
    // POSIX 絶対パス（/Users/… 等、2階層以上）と Windows 絶対パス。
    // 相対パスやURLのpathは触らない（誤爆で本文を壊さないため）。
    pattern: /(?:\/(?:[\w.@-]+\/)+[\w.@-]+|\b[A-Za-z]:\\(?:[\w. @()-]+\\)+[\w. @()-]+)/g,
    replacement: "<path>",
  },
];

export function sanitizeConversation(raw: RawConversation): SanitizedConversation {
  const removed = new Set<SanitizedKind>();
  const sanitize = (text: string): string => {
    let next = text;
    for (const { kind, pattern, replacement } of PATTERNS) {
      next = next.replace(pattern, () => {
        removed.add(kind);
        return replacement;
      });
    }
    return next;
  };
  let body = sanitize(raw.body);
  // タイトルも送信対象の一部なので本文と同じ規則でマスクする。
  const title = raw.title === undefined ? undefined : sanitize(raw.title);
  if (body.length > MAX_BODY_CHARS) {
    body = body.slice(0, MAX_BODY_CHARS);
    removed.add("truncated");
  }
  if (removed.size === 0 && body === raw.body && title === raw.title) {
    return { conversation: raw, removedKinds: [] };
  }
  return {
    conversation: { ...raw, body, ...(title === undefined ? {} : { title }) },
    removedKinds: [...removed],
  };
}

/** 同一本文の検出キー。前後空白と大小文字を潰してから SHA-256。 */
export function conversationDigest(conversation: RawConversation): string {
  return createHash("sha256").update(conversation.body.trim().toLowerCase()).digest("hex");
}

/**
 * 同一 body の会話を重複として除く。先に来たものを残す。
 *
 * externalRefHash による API 側の冪等とは別物。こちらは「別ソースに同じ
 * 会話がコピーされている」「エクスポート内で重複している」場合を潰す。
 */
export function dedupeConversations(conversations: readonly RawConversation[]): {
  conversations: RawConversation[];
  duplicateCount: number;
} {
  const seen = new Set<string>();
  const result: RawConversation[] = [];
  let duplicateCount = 0;
  for (const conversation of conversations) {
    const digest = conversationDigest(conversation);
    if (seen.has(digest)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(digest);
    result.push(conversation);
  }
  return { conversations: result, duplicateCount };
}
