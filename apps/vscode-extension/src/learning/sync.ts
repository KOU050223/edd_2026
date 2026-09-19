/**
 * LearningEvent をAPIサーバーへ同期する。
 *
 * globalStateへのローカル保存（store.ts）とは別に、サーバー側の正本（D1）へも
 * 送る。docs/architecture.md の通りサーバー側が習熟度導出の正本であり、
 * ローカル保存だけでは他端末やWebから見えない。
 *
 * apps/api の外部契約（apps/api/src/contract/learning-event.ts）をそのまま
 * importしない。apps/api/README.md が「このアプリ固有の型を他パッケージから
 * 参照させない」と定めているため、送受信に必要な最小限の形をここで独自に持つ。
 *
 * 同期に失敗しても例外を投げない。store.ts の recordEvent と同じ方針で、
 * 同期の失敗が質問フローを止めてはならない。呼び出し側はログに残すためだけに
 * 戻り値を使う。
 */

import type { LearningEvent } from "@gakushu-sochi/domain";

/** 同期に使う設定。VS Codeの設定（package.jsonのcontributes.configuration）から読む値をここへ集約する。 */
export interface SyncConfig {
  /** 例: https://gakushu-sochi-api.uozumi05.workers.dev */
  apiBaseUrl: string;
  /** `Authorization: Bearer <token>` に使う短命トークンを取得する。 */
  apiToken: () => Promise<string>;
  /** この端末のID。store.ts の getOrCreateClientId で取得する。 */
  clientId: string;
}

/** サーバーがイベント1件ごとに返す結果種別。apps/api/src/contract/learning-event.ts の SyncResultStatus と対応する。 */
export type SyncEventStatus = "accepted" | "duplicate" | "rejected";

/** サーバー応答の最小限の形。呼び出し側が使わない項目は持たない。 */
interface SyncResponseBody {
  results: { status: SyncEventStatus; reason?: string }[];
}

export type SyncOutcome =
  { ok: true; status: SyncEventStatus; reason?: string } | { ok: false; reason: string };

/**
 * 応答が返らない場合に待ち続けない上限。
 *
 * fetch は既定でタイムアウトしないため、これが無いと syncEvent が解決せず、
 * 呼び出し元の persistEvent も待ち続ける。同期は質問フローを止めてはならない。
 */
const TIMEOUT_MS = 10_000;

/**
 * 送信先として安全なURLかどうか。
 *
 * apiBaseUrl には `Authorization: Bearer` を付けて送るため、平文の http: を許すと
 * トークンが盗聴されうる。https: を基本とし、ローカル開発（apps/api の
 * `npm run dev` は http://localhost:8787）だけ例外として認める。
 * apps/desktop の isSafeApiBaseUrl と同じ判断基準を用いる。
 */
function isSafeApiBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * 1件の学習イベントをAPIサーバーへ送る。
 *
 * `POST /v1/learning-events:sync` は複数件をまとめて送れるバッチAPIだが、
 * persistEvent がイベントを1件ずつ確定させるのに合わせて、ここでも1件ずつ送る。
 * まとめ送りは、送信頻度が実際に問題になってから最適化する。
 */
export async function syncEvent(event: LearningEvent, config: SyncConfig): Promise<SyncOutcome> {
  if (!isSafeApiBaseUrl(config.apiBaseUrl)) {
    // トークンを載せる前に弾く。ワークスペース設定で書き換えられた不正なURLへ
    // 送ってしまうと、トークンと学習イベントが第三者へ渡る。
    return {
      ok: false,
      reason: `APIのURLが安全ではありません（https、またはローカル開発のみ許可）: ${config.apiBaseUrl}`,
    };
  }

  const url = `${config.apiBaseUrl.replace(/\/+$/, "")}/v1/learning-events:sync`;

  let result: { status: SyncEventStatus; reason?: string } | undefined;
  try {
    const apiToken = await config.apiToken();
    if (!apiToken) return { ok: false, reason: "再ログインが必要です" };
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({ clientId: config.clientId, events: [event] }),
      // リダイレクトを自動追跡しない。転送先へ Authorization ヘッダごと
      // 送られると、トークンが意図しない相手に渡る。
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      if (response.status === 401) return { ok: false, reason: "再ログインが必要です" };
      return { ok: false, reason: `HTTP ${response.status}` };
    }

    // 応答本文の解析も try の中に置く。空・壊れたJSONで reject すると、
    // 例外を投げない約束（このファイル冒頭）を破って質問フローまで伝播する。
    const body = (await response.json()) as SyncResponseBody;
    if (!Array.isArray(body?.results)) {
      return { ok: false, reason: "サーバー応答の形式が不正です（results が配列ではありません）" };
    }
    result = body.results[0];
  } catch (error) {
    if (error instanceof Error && error.message === "再ログインが必要です") {
      return { ok: false, reason: "再ログインが必要です" };
    }
    return { ok: false, reason: `ネットワークエラー: ${String(error)}` };
  }

  if (!result) {
    // 件数が合わない応答はサーバー側のバグである。黙って「成功」扱いにしない。
    return { ok: false, reason: "サーバー応答にこのイベントの結果が含まれていません" };
  }

  return { ok: true, status: result.status, reason: result.reason };
}
