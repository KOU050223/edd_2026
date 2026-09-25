import { createFileRoute, Link } from "@tanstack/react-router";
import { fetchAiUsage, PLAN_LABELS } from "../../../ai-usage.js";
import { takeLoginRetry } from "../../../session.js";

/**
 * 現在のプラン。当面 Free のみなので、実装済みの事実だけを並べる
 * （docs/ai-limits.md「決定: 当面 Free のみ。Pro は作らない」）。
 *
 * 支払い方法や請求履歴の欄は置かない。未実装の空欄は利用者から見れば壊れているのと
 * 区別がつかない（Issue #123）。Pro の予告だけはその例外として出すが、
 * 価格・時期・機能差のような決まっていないことは書かない（Issue #165）。
 */
function Billing() {
  const { plan, managedAi } = Route.useLoaderData();
  const label = PLAN_LABELS[plan];
  return (
    <section>
      <h2>プラン</h2>
      <article className="plan-card">
        <h3>現在のプラン</h3>
        <p className="plan-name">{label.name}</p>
        <p>{label.price}</p>
        <h4>Managed AI</h4>
        <ul>
          <li>月 {managedAi.monthly.limit} 回まで</li>
          <li>日 {managedAi.daily.limit} 回まで</li>
        </ul>
        <p>
          <Link to="/settings/usage">使用状況を見る</Link>
        </p>
      </article>
      <article className="plan-card upcoming">
        <h3>より多く AI を使える Pro プランを準備中です</h3>
        <p className="muted">現在、有料プランは提供していません。</p>
        {/* 決済が無いので押せなくしておく。押せるのに動かないと感じさせないよう、
            準備中であることを文言に含める。 */}
        <button type="button" disabled>
          Pro にアップグレード（準備中）
        </button>
      </article>
    </section>
  );
}

export const Route = createFileRoute("/_framed/settings/billing")({
  // 上限の数字は API から取る。画面に持たせると、政策値を動かしたときに
  // この画面だけが古い上限を示す。
  loader: () => fetchAiUsage(fetch, takeLoginRetry()),
  component: Billing,
});
