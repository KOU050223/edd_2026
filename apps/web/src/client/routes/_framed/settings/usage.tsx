import { createFileRoute, useRouter } from "@tanstack/react-router";
import { fetchAiUsage, formatResetAt, toPeriodView, type PeriodView } from "../../../ai-usage.js";
import { takeLoginRetry } from "../../../session.js";

function UsageCard({
  title,
  view,
  primary,
}: {
  title: string;
  view: PeriodView;
  primary?: boolean;
}) {
  return (
    <article className={primary ? "usage-card primary" : "usage-card"}>
      <h3>{title}</h3>
      <p className="usage-count">
        <strong>{view.used}</strong> / {view.limit} 回
      </p>
      <p>残り {view.remaining} 回</p>
      <div
        className="usage-bar"
        role="progressbar"
        aria-label={`${title}の使用回数`}
        aria-valuemin={0}
        aria-valuemax={view.limit}
        aria-valuenow={Math.min(view.used, view.limit)}
      >
        <i style={{ width: `${view.percentage}%` }} />
      </div>
      <p className="muted">{formatResetAt(view.resetAt)} にリセット</p>
    </article>
  );
}

/**
 * Managed AI の使用状況。上限に当たる前に残量を確かめられるようにする。
 *
 * 回数だけを出す。トークン数は利用者へ見せない安全弁であり、API も返さない
 * （docs/ai-limits.md「利用者への見せ方」）。
 */
function Usage() {
  const usage = Route.useLoaderData();
  const router = useRouter();
  return (
    <section>
      <h2>使用状況</h2>
      <div className="usage-cards">
        <UsageCard title="今月の Managed AI" view={toPeriodView(usage.managedAi.monthly)} primary />
        <UsageCard title="今日の Managed AI" view={toPeriodView(usage.managedAi.daily)} />
      </div>
      <p className="note">
        ここに表示されるのは学習装置が提供する Managed AI の利用量です。GitHub Copilot や BYOK
        で利用している AI の使用量は含まれません。
      </p>
      <div className="actions">
        <button type="button" onClick={() => void router.invalidate()}>
          再読み込み
        </button>
      </div>
    </section>
  );
}

export const Route = createFileRoute("/_framed/settings/usage")({
  loader: () => fetchAiUsage(fetch, takeLoginRetry()),
  component: Usage,
});
