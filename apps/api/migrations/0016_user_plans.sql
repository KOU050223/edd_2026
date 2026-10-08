-- 利用者のプラン（#289）。
--
-- ## user_plans
--
-- AI 生成の回数上限をプランごとに決めるための記録（src/contract/ai-usage.ts の PLAN_LIMITS）。
-- 行が無い利用者は free。課金はまだ無いので、plus にするときは wrangler d1 execute で
-- 手で行を入れる（apps/api/README.md）。**プランを変える API は作らない。**
-- Cloudflare に入れる人しか変えられないので、利用者が自分を plus にすることはできない。
-- 退会では users と一緒に消える。
CREATE TABLE user_plans (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL CHECK (plan IN ('free', 'plus')),
  updated_at TEXT NOT NULL
);
