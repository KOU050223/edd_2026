/**
 * `POST /v1/learning-events:sync`。
 *
 * オフラインキューを同期するためのプロトコルであり、「イベントを一件作る」
 * CRUD API ではない（docs/architecture.md）。
 */

import { Hono } from "hono";
import { vValidator } from "@hono/valibot-validator";
import * as v from "valibot";
import {
  learningEventSchema,
  syncRequestSchema,
  type SyncEventResult,
  type SyncResponse,
  type SyncResultStatus,
} from "../contract/learning-event.js";
import type { AuthVariables } from "../auth/middleware.js";
import type { IdentityRepository, LearningEventRepository } from "../repository/types.js";
import type { StoredEventInput } from "../repository/types.js";

export interface SyncDeps {
  identity: IdentityRepository;
  events: LearningEventRepository;
  /** 現在時刻（epoch ミリ秒）。テストで固定できるよう注入する。 */
  now: () => number;
}

/**
 * 依存の解決。
 *
 * Bindings はリクエストごとに渡るため、依存を組み立てられるのもリクエスト時である。
 * 値ではなく関数で受け取り、本番は D1、テストはインメモリ実装を返す。
 */
export type SyncDepsResolver = (env: CloudflareBindings) => SyncDeps;

/**
 * valibot の issue を1行の理由へ畳む。
 *
 * 全 issue を返さないのは、拒否理由がリクエストボディの内容を反映しうるためである。
 * 値そのものではなくパスと要約だけを返し、コード本文や質問文が
 * エラーメッセージ経由でログや画面へ漏れないようにする。
 */
function toRejectionReason(issues: readonly v.BaseIssue<unknown>[]): string {
  const first = issues[0];
  if (first === undefined) {
    return "invalid event";
  }
  const path = first.path?.map((segment) => String(segment.key)).join(".");
  return path ? `${path}: ${first.message}` : first.message;
}

/**
 * 検証を通ったイベントの ID を、そのリクエスト内で重複していないか調べる。
 *
 * 同じバッチに同じ ID が2回入っていると、DB へは1件しか入らないのに
 * 2件とも「受理」と応答してしまう。リクエスト内の重複はクライアント側の
 * 不具合なので、握りつぶさず拒否として返す。
 */
function findDuplicateIndexes(ids: readonly string[]): Set<number> {
  const seen = new Map<string, number>();
  const duplicates = new Set<number>();
  ids.forEach((id, index) => {
    if (seen.has(id)) {
      duplicates.add(index);
    } else {
      seen.set(id, index);
    }
  });
  return duplicates;
}

export function createLearningEventsRoute(resolve: SyncDepsResolver) {
  const app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();

  app.post("/learning-events:sync", vValidator("json", syncRequestSchema), async (c) => {
    // エンベロープだけをスキーマで検証し、各イベントは個別に検証する。
    // 全体を1つのスキーマで検証すると、1件の不正でバッチ全体が失敗し、
    // 同じバッチの正常なイベントまで捨ててしまう。
    const { clientId, events } = c.req.valid("json");
    const userId = c.get("user").userId;
    const deps = resolve(c.env);

    // 検証結果を位置ごとに保持する。results は必ず入力と同じ順序・件数で返す。
    const results: (SyncEventResult | undefined)[] = new Array(events.length);
    const accepted: { index: number; input: StoredEventInput }[] = [];

    events.forEach((candidate, index) => {
      const parsed = v.safeParse(learningEventSchema, candidate);
      if (!parsed.success) {
        results[index] = {
          index,
          // ID が読めない場合もあるため、読めたときだけ返す。
          id:
            typeof (candidate as { id?: unknown })?.id === "string"
              ? (candidate as { id: string }).id
              : null,
          status: "rejected",
          reason: toRejectionReason(parsed.issues),
        };
        return;
      }
      accepted.push({
        index,
        input: { event: parsed.output, clientId, receivedAtMs: deps.now() },
      });
    });

    // 同一リクエスト内で ID が重複しているものを弾く。
    const duplicateIndexes = findDuplicateIndexes(accepted.map((a) => a.input.event.id));
    const toStore = accepted.filter((a, i) => {
      if (duplicateIndexes.has(i)) {
        results[a.index] = {
          index: a.index,
          id: a.input.event.id,
          status: "rejected",
          reason: "duplicate id within the same request",
        };
        return false;
      }
      return true;
    });

    if (toStore.length > 0) {
      // イベントを書く前にユーザーと端末の行を用意する。learning_events は
      // users(id) を参照しており、D1 は外部キーを実際に強制するため、
      // これが無いと同期は必ず失敗する。
      await deps.identity.ensureUserAndDevice({ userId, clientId, nowMs: deps.now() });

      const appended = await deps.events.append(
        userId,
        toStore.map((a) => a.input),
      );

      appended.forEach((result, i) => {
        const target = toStore[i];
        if (target === undefined) {
          return;
        }
        results[target.index] = {
          index: target.index,
          id: result.id,
          status: result.duplicate ? "duplicate" : "accepted",
        };
      });
    }

    const finalized = results.map((result, index) => {
      // 取りこぼしがあれば埋めずに落とす。件数が合わない応答を返すと、
      // クライアントは対応づけに失敗したイベントを送信キューから
      // 取り除いてよいか判断できない。
      if (result === undefined) {
        throw new Error(`sync result missing for index ${index}`);
      }
      return result;
    });

    const summary: Record<SyncResultStatus, number> = {
      accepted: 0,
      duplicate: 0,
      rejected: 0,
    };
    for (const result of finalized) {
      summary[result.status] += 1;
    }

    // 削除時刻は append の後で読む。このリクエストの処理中に割り込んだ
    // DELETE /v1/learning-events も拾えるようにするため。クライアントは
    // 前回より新しい時刻を受け取ったらローカルのコピーを消す（Issue #124）。
    const historyResetAtMs = await deps.events.latestResetAtMs(userId);

    const body: SyncResponse = { results: finalized, summary, historyResetAtMs };
    return c.json(body);
  });

  return app;
}
