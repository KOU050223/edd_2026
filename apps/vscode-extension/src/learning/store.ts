/**
 * LearnerProfile の globalState への読み書き。
 *
 * globalState に触れるのはこのファイルだけにする。読み込み・保存の失敗や
 * バージョン不一致をここへ閉じ込め、呼び出し側（extension.ts）は常に
 * 使える LearnerProfile を受け取れるようにする。
 */

import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import {
  applyEvent,
  createEmptyProfile,
  LEARNER_PROFILE_VERSION,
  type LearnerProfile,
  type LearningEvent,
} from "@gakushu-sochi/domain";
import { isExplainedErrors, type ExplainedErrors } from "./recurrence";

/** globalState 上のキー。docs/concepts.md の「保存」を参照。 */
const PROFILE_KEY = "gakushuSochi.learnerProfile";

/**
 * 旧キー。プロダクト名を変更する前に使っていた。
 *
 * 既に保存されている利用者の学習履歴は再取得できないため、キーを変えただけで
 * 読めなくなる状態にしない。docs/concepts.md の「古いデータを黙って捨てない」に従い、
 * 新しいキーが空のときに限り読み替えて引き継ぐ。
 *
 * 旧キーの値は消さない。移行に失敗した場合の退避先として残す。
 */
const LEGACY_PROFILE_KEY = "codeCompanion.learnerProfile";

/**
 * 保存値が現在の LEARNER_PROFILE_VERSION を持ち、そのまま使える形の
 * LearnerProfile かを検査する。
 *
 * docs/concepts.md の「読み込み時の処理」は version の大小で分岐（マイグレーション /
 * 読み取り専用）することを理想としているが、version 2 以降がまだ存在しないため
 * `src/learning/migrate.ts` は作っていない。ここでは version が一致しない場合と
 * 構造が壊れている場合をまとめて「使えない」として扱い、新規プロファイルを
 * 作り直す簡略実装にとどめる。
 * version 2 が生まれたら、この関数をマイグレーション適用の入口に置き換える。
 *
 * version だけを見るのでは足りない。`applyEvent` は `profile.events` を展開し
 * `profile.mastery` を複製するため、version が現在値でもそれらが欠けていれば
 * イベント記録時に TypeError で落ちる。読み込み時点で弾いて、壊れた値を
 * 使える LearnerProfile として呼び出し側へ渡さない。
 */
function isCurrentVersionProfile(value: unknown): value is LearnerProfile {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<LearnerProfile>;
  return (
    candidate.version === LEARNER_PROFILE_VERSION &&
    Array.isArray(candidate.events) &&
    typeof candidate.mastery === "object" &&
    candidate.mastery !== null
  );
}

/**
 * globalState から LearnerProfile を読み込む。無い・壊れている場合は空のプロファイルを返す。
 *
 * 新しいキーに値が無ければ旧キーを見る。読めたものは呼び出し側が保存した時点で
 * 新しいキーへ移る（`recordEvent` は常に新しいキーへ書く）ため、ここでは
 * 書き戻しをしない。読み込みだけで globalState を更新すると、VS Code の起動直後に
 * 副作用が走り、失敗したときに握りつぶすか起動を止めるかの二択になる。
 */
export function loadProfile(context: vscode.ExtensionContext): LearnerProfile {
  const stored = context.globalState.get<unknown>(PROFILE_KEY);
  if (isCurrentVersionProfile(stored)) {
    return stored;
  }

  const legacy = context.globalState.get<unknown>(LEGACY_PROFILE_KEY);
  if (isCurrentVersionProfile(legacy)) {
    return legacy;
  }

  return createEmptyProfile(new Date().toISOString());
}

/**
 * LearnerProfile を globalState へ保存する。
 *
 * 失敗しても例外を投げない。保存失敗が質問フローを止めてはならない
 * （MVP/02 #23 の完了条件）ため、成否は `onError` への通知だけに留める。
 */
async function saveProfile(
  context: vscode.ExtensionContext,
  profile: LearnerProfile,
  onError?: (error: unknown) => void,
): Promise<void> {
  try {
    await context.globalState.update(PROFILE_KEY, profile);
  } catch (error) {
    onError?.(error);
  }
}

/**
 * 1件の学習イベントを反映し、globalState へ保存する。
 *
 * 保存に失敗しても、更新後の LearnerProfile はそのまま返す。今回のセッション中は
 * 記録が反映された状態で動作を続けられるようにするためで、次回起動時に
 * 保存前の状態へ戻りうることは docs/concepts.md の保存契約通りである。
 */
export async function recordEvent(
  context: vscode.ExtensionContext,
  profile: LearnerProfile,
  event: LearningEvent,
  onError?: (error: unknown) => void,
): Promise<LearnerProfile> {
  const updated = applyEvent(profile, event);
  await saveProfile(context, updated, onError);
  return updated;
}

/** この端末を識別するIDをglobalStateに保存するキー。 */
const CLIENT_ID_KEY = "gakushuSochi.clientId";

/**
 * この端末を識別するIDを取得する。無ければ新しく作って保存する。
 *
 * サーバー側の userId（認証トークンから決まる、誰か）とは別物で、
 * 同じユーザーが複数端末を使ったときにどちらから届いたイベントかを
 * 区別するためのものである（apps/api/migrations/0001_initial.sql の devices）。
 * ユーザーIDと違い秘密情報ではないため、平文でglobalStateへ保存してよい。
 */
export async function getOrCreateClientId(context: vscode.ExtensionContext): Promise<string> {
  const existing = context.globalState.get<string>(CLIENT_ID_KEY);
  if (typeof existing === "string" && existing.length > 0) {
    return existing;
  }

  const clientId = randomUUID();
  await context.globalState.update(CLIENT_ID_KEY, clientId);
  return clientId;
}

/** 解説済みエラー（再発判定の入力）を保存するキー。docs/concepts.md の「保存」を参照。 */
const EXPLAINED_ERRORS_KEY = "gakushuSochi.explainedErrors";

/**
 * 解説済みエラーを読み込む。無ければ空を返す。
 *
 * 壊れた値は使わずに空から始めるが、黙って捨てない。`onError` へ通知する。
 * 失うのは再発判定の記憶だけで、LearnerProfile は影響を受けない。
 */
export function loadExplainedErrors(
  context: vscode.ExtensionContext,
  onError?: (error: unknown) => void,
): ExplainedErrors {
  const stored = context.globalState.get<unknown>(EXPLAINED_ERRORS_KEY);
  if (stored === undefined) {
    return {};
  }
  if (!isExplainedErrors(stored)) {
    onError?.(new TypeError(`${EXPLAINED_ERRORS_KEY} の保存値が壊れているため読み捨てました`));
    return {};
  }
  return stored;
}

/**
 * 解説済みエラーを保存する。`saveProfile` と同じく、失敗しても例外を投げず
 * `onError` へ通知する。再発判定の記録が質問フローを止めてはならない。
 */
export async function saveExplainedErrors(
  context: vscode.ExtensionContext,
  explained: ExplainedErrors,
  onError?: (error: unknown) => void,
): Promise<void> {
  try {
    await context.globalState.update(EXPLAINED_ERRORS_KEY, explained);
  } catch (error) {
    onError?.(error);
  }
}
