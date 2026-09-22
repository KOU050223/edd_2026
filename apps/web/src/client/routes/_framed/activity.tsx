import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { fillActivityDays, requestJson, type ActivityDay } from "../../api.js";
import {
  ACTIVITY_PERIOD_DAYS,
  isUserSettings,
  type UserSettings,
} from "../../../shared/settings.js";
import { parsePeriodSearch, resolvePeriod } from "../../activity-period.js";
import { ApiError } from "../../api.js";
import { takeLoginRetry } from "../../session.js";

type Activity = { from: string; to: string; days: ActivityDay[] };

function Chart({ days }: { days: ActivityDay[] }) {
  const kinds = ["solved_independently", "hint_used", "error_recurred"];
  const max = Math.max(
    1,
    ...days.map((day) => Object.values(day.counts).reduce((sum, count) => sum + count, 0)),
  );
  return (
    <div className="chart">
      {days.map((day) => (
        <div
          className="bar"
          title={`${day.date}: ${Object.values(day.counts).reduce((a, b) => a + b, 0)} 件`}
          key={day.date}
        >
          {kinds.map((kind) => (
            <i
              key={kind}
              className={kind}
              style={{ height: `${((day.counts[kind] ?? 0) / max) * 100}%` }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function ActivityView() {
  const { activity, period } = Route.useLoaderData();
  const router = useRouter();
  const days = fillActivityDays(activity);
  return (
    <>
      <section className="periods">
        {ACTIVITY_PERIOD_DAYS.map((value) => (
          <Link
            to="/activity"
            search={{ days: value }}
            className={period === value ? "selected" : ""}
            key={value}
          >
            {value} 日
          </Link>
        ))}
        <button onClick={() => router.invalidate()}>再読み込み</button>
      </section>
      {activity.days.length === 0 ? (
        <section className="message">まだ学習イベントがありません</section>
      ) : (
        <>
          <Chart days={days} />
          <p className="legend">
            <i className="solved_independently" />
            自力解決 <i className="hint_used" />
            ヒント利用 <i className="error_recurred" />
            エラー再発
          </p>
        </>
      )}
    </>
  );
}

export const Route = createFileRoute("/_framed/activity")({
  // 期間は URL に載せる。載せないと、再読み込みや共有で選択が消える。
  // 判断は `activity-period.ts` にある（描画から切り離さないと検証できない）。
  validateSearch: parsePeriodSearch,
  // **`loaderDeps` でもう一度通す。** `validateSearch` が捨てた値は
  // `search` から消えない（TanStack/router#1965。親から併合されるため、
  // 型では `days?: 7|30|90` でも実際には `?days=999` がそのまま入る）。
  // ここを素通しにすると、検証していない値が API の要求に載る。
  loaderDeps: ({ search }) => parsePeriodSearch(search),
  // 既定の期間は設定から来る。URL に指定が無いときだけ設定を読むので、
  // 期間が決まるまで表示が揺れることがない。
  loader: async ({ deps }) => {
    const retry = takeLoginRetry();
    const period = await resolvePeriod(deps.days, async () => {
      const settings = await requestJson<UserSettings>("/api/v1/user-settings", fetch, retry);
      // 2xx でも中身が契約どおりでなければ失敗として扱う（RULE-004）。
      if (!isUserSettings(settings)) throw new ApiError("unavailable");
      return settings.activityPeriodDays;
    });
    const activity = await requestJson<Activity>(
      `/api/v1/learning-activity?days=${period}`,
      fetch,
      retry,
    );
    return { activity, period };
  },
  component: ActivityView,
});
