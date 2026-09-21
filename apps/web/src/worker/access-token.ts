/**
 * セッションに紐づくアクセストークンを、中継の直前に用意する。
 *
 * ここが引き受けているのは docs/auth.md §5.3 の 3 つの要求である。
 *
 * 1. **AT を KV へ書かない。** KV 書き込みは読み取りの 10 倍の単価で、AT の寿命 15 分だと
 *    セッションあたり最大 4 回/時の書き込みになる。Worker のメモリにだけ置く。
 * 2. **refresh の失敗を一律に扱わない。** セッションを消すのは `invalid_grant` のときだけ。
 *    5xx・タイムアウト・レート制限ではセッションを残し、再試行可能なエラーを返す。
 * 3. **rotation の同時実行を直列化する。** 並行 refresh は新しい RT を古い値で上書きし、
 *    利用者をランダムにログアウトさせる。
 *
 * ## single-flight の手段の決定（Issue #84 がここで決めろと書いている項目）
 *
 * **Durable Object ではなく、isolate 内のメモリで直列化する。**
 *
 * Workers KV には条件付き書き込み（CAS）が無い。`put` は無条件の上書きだけで、
 * `getWithMetadata` が返す値を使った楽観的更新は**実装できない**。
 * つまり「KV の楽観的更新」という選択肢は最初から成立しない。
 *
 * 残るのは DO かメモリだが、DO は次の理由で採らない。
 *
 * - この競合が起きるのは**1 人のブラウザが同時に投げる数本の要求**である
 *   （画面は `Promise.all` で profile と overrides を並べて取る）。
 *   同じセッションの、同時に飛ぶ数本は同じ Worker isolate へ入るのが通常であり、
 *   メモリの single-flight がそのまま効く。
 * - isolate をまたいだ場合に残る競合は Auth0 の `leeway` 30 秒（docs/auth.md §5.3）が
 *   吸収する。**leeway は競合を解消しないが、この幅の同時実行は救う。**
 * - DO を 1 つ入れると、この Worker に永続オブジェクトの運用とデプロイ手順が付く。
 *   利用者がまだ居ない段階で、効果の差が「leeway を超えるずれ」だけの機構を先に抱えない。
 *
 * **この決定が破れる条件を書いておく。** isolate をまたぐ並行 refresh が leeway 30 秒を
 * 超えてずれ、利用者がランダムにログアウトする事象が観測されたら、DO へ移す。
 * そのときに変わるのはこのファイルの中だけで、`index.ts` の呼び出しは変わらない。
 */
import {
  OAuthTokenError,
  refreshAccessToken,
  type OAuthConfig,
  type RefreshedAccessToken,
} from "./oauth.js";
import { deleteSession, writeSession, type SessionRecord } from "./session.js";

/**
 * 期限のどれだけ手前で取り直すか。
 *
 * 中継の往復中に切れるトークンを渡さないための余裕。AT の寿命は 900 秒なので、
 * 60 秒手前で取り直しても取得回数はセッションあたり時間 4 回のままになる。
 */
const REFRESH_MARGIN_SECONDS = 60;

interface CacheEntry {
  accessToken: string;
  /** epoch ミリ秒。これを過ぎたら取り直す。 */
  expiresAtMs: number;
}

/** refresh が失敗した理由。呼び出し側はこれで応答を分ける。 */
export type AccessTokenFailure =
  /** RT が失効・撤回済み。セッションは削除済みなので、利用者は再ログインへ倒す。 */
  | { kind: "session_expired" }
  /** 一時的な失敗。**セッションは残っている**ので、そのまま再試行できる。 */
  | { kind: "auth_unavailable" };

export type AccessTokenResult =
  { ok: true; accessToken: string } | ({ ok: false } & AccessTokenFailure);

export interface AccessTokenProviderDeps {
  fetch: typeof fetch;
  /** テストが時間を進められるようにする。既定は実時計。 */
  now?: () => number;
}

export interface AccessTokenProvider {
  get(
    sessions: KVNamespace,
    sessionToken: string,
    session: SessionRecord,
    config: OAuthConfig,
  ): Promise<AccessTokenResult>;
  /** ログアウト時に、そのセッションのキャッシュを捨てる。 */
  forget(sessionToken: string): void;
}

export function createAccessTokenProvider(deps: AccessTokenProviderDeps): AccessTokenProvider {
  const now = deps.now ?? (() => Date.now());
  const cache = new Map<string, CacheEntry>();
  /** 進行中の refresh。同じセッションの 2 本目はこれに合流し、二重に回さない。 */
  const inFlight = new Map<string, Promise<AccessTokenResult>>();
  /**
   * `forget` されたセッション。**進行中の refresh が結果を書き戻すのを止めるためにある。**
   *
   * ログアウトは KV を消してから撤回する。その最中に別の要求が refresh を回していると、
   * 撤回が終わった後に `writeSession` が走り、**消したはずのセッションが KV へ蘇る**。
   * キャッシュも新しい AT で埋まるので、Cookie を持っている者はログアウト後も通る。
   *
   * 外向きの応答を待っている間に消されたかを、**書き戻す直前に**見る必要がある。
   * 消えた印は `inFlight` が空になったときに落とす（進行中のものが全部見終わった後）。
   */
  const revoked = new Set<string>();

  async function refresh(
    sessions: KVNamespace,
    sessionToken: string,
    session: SessionRecord,
    config: OAuthConfig,
  ): Promise<AccessTokenResult> {
    let refreshed: RefreshedAccessToken;
    try {
      refreshed = await refreshAccessToken(config, session.refreshToken, deps.fetch);
      // 外向きの応答を待っている間にログアウトされていないか、**書き戻す前に**見る。
      // ここを通さないと、消したセッションが下の writeSession で蘇る。
      if (revoked.has(sessionToken)) {
        console.warn("session was revoked while refreshing; discarding result", {
          sub: session.sub,
        });
        return { ok: false, kind: "session_expired" };
      }
    } catch (error) {
      // 失敗を一律に扱わない（docs/auth.md §5.3）。どちらの枝でも握りつぶさず記録する。
      if (error instanceof OAuthTokenError && error.isInvalidGrant) {
        // RT が二度と使えないことが確定した。ここでだけセッションを消す。
        console.warn("refresh token rejected; dropping session", { sub: session.sub });
        cache.delete(sessionToken);
        await deleteSession(sessions, sessionToken);
        return { ok: false, kind: "session_expired" };
      }
      // タイムアウト・5xx・レート制限・ネットワーク障害。**セッションを残す。**
      // ここを区別しないと Auth0 の一時的な 5xx 一回で全利用者がログアウトする。
      console.error("access token refresh failed; keeping session", {
        sub: session.sub,
        status: error instanceof OAuthTokenError ? error.status : undefined,
        code: error instanceof OAuthTokenError ? error.code : undefined,
        message: error instanceof Error ? error.message : String(error),
      });
      return { ok: false, kind: "auth_unavailable" };
    }

    if (refreshed.refreshToken) {
      // rotation で RT が回った。**新しい方の保存は、この refresh の成立条件である。**
      //
      // 保存に失敗したまま成功を返すと、KV には既に無効な古い RT が残る。
      // AT をキャッシュしてしまうと、期限が切れた後の refresh が `invalid_grant` になり、
      // **何も操作していない利用者が十数分後に突然ログアウトする**。
      // 原因から離れた場所で壊れるので、ここで失敗として扱う（RULE-004）。
      try {
        await writeSession(sessions, sessionToken, {
          refreshToken: refreshed.refreshToken,
          sub: session.sub,
        });
        session.refreshToken = refreshed.refreshToken;
      } catch (error) {
        console.error("failed to persist rotated refresh token", {
          sub: session.sub,
          message: error instanceof Error ? error.message : String(error),
        });
        // キャッシュしない。次の要求が同じ古い RT でやり直せる（rotation の leeway 30 秒
        // の内側なら通る）。成功を返して先へ進ませるより、ここで再試行させる方が近い。
        cache.delete(sessionToken);
        return { ok: false, kind: "auth_unavailable" };
      }
    }

    if (refreshed.expiresInSeconds > REFRESH_MARGIN_SECONDS) {
      cache.set(sessionToken, {
        accessToken: refreshed.accessToken,
        expiresAtMs: now() + (refreshed.expiresInSeconds - REFRESH_MARGIN_SECONDS) * 1_000,
      });
    }
    return { ok: true, accessToken: refreshed.accessToken };
  }

  return {
    async get(sessions, sessionToken, session, config) {
      const cached = cache.get(sessionToken);
      if (cached && cached.expiresAtMs > now()) {
        return { ok: true, accessToken: cached.accessToken };
      }

      // 同じセッションの refresh が既に走っているなら、それに合流する。
      // ここが single-flight の本体で、rotation の同時実行を止めている。
      const running = inFlight.get(sessionToken);
      if (running) return running;

      const attempt = refresh(sessions, sessionToken, session, config).finally(() => {
        inFlight.delete(sessionToken);
        // 進行中のものが見終わったので、失効の印は役目を終える。
        // 残し続けると、同じ token を再取得できなくなる（現実には起きないが、
        // Set が isolate の寿命だけ膨らみ続けるのも避ける）。
        if (!inFlight.has(sessionToken)) revoked.delete(sessionToken);
      });
      inFlight.set(sessionToken, attempt);
      return attempt;
    },
    forget(sessionToken) {
      cache.delete(sessionToken);
      // 進行中の refresh があるなら、その結果を書き戻させない。
      // 無ければ印は不要だが、`get` と `forget` の間に始まる refresh も止めたいので
      // 一律に立てる。印は進行中のものが片付いたときに落ちる。
      if (inFlight.has(sessionToken)) revoked.add(sessionToken);
    },
  };
}
