/**
 * 理解度の手動上書きを Workers KV に保存する。
 *
 * ここに置くのは**上書きの記録だけ**で、習熟度そのものの正本は持たない
 * （`apps/web/AGENTS.md`「習熟度の正本を持たず、API Server から取得する」）。
 * 自動算出の status / score / evidence は API の応答のまま変えず、
 * 表示のときにこの記録を重ねる。VS Code 拡張への同期は Issue #47 のスコープ外。
 */
const OVERRIDES_KEY = "mastery-overrides";

export const MASTERY_STATUSES = ["unobserved", "learning", "confirmed"] as const;
export type MasteryStatus = (typeof MASTERY_STATUSES)[number];

export interface MasteryOverride {
  status: MasteryStatus;
  updatedAt: string;
}

export type MasteryOverrides = Record<string, MasteryOverride>;

function isMasteryStatus(value: unknown): value is MasteryStatus {
  return MASTERY_STATUSES.includes(value as MasteryStatus);
}

/** 保存された JSON を読む。壊れていたら捨てずに失敗させる（握りつぶさない）。 */
export async function readOverrides(kv: KVNamespace): Promise<MasteryOverrides> {
  const stored = await kv.get(OVERRIDES_KEY);
  if (stored === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch (error) {
    // 既定値（空の上書き）へ黙って倒すと、壊れていることが誰にも見えないまま
    // 手動修正が消える（.agents/rules/rules.md RULE-004）。原因を付けて失敗させる。
    throw new Error("stored mastery overrides are corrupted", { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("stored mastery overrides are corrupted");
  }
  const overrides: MasteryOverrides = {};
  for (const [conceptId, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) continue;
    const { status, updatedAt } = entry as { status?: unknown; updatedAt?: unknown };
    if (!isMasteryStatus(status)) continue;
    overrides[conceptId] = { status, updatedAt: typeof updatedAt === "string" ? updatedAt : "" };
  }
  return overrides;
}

/**
 * 1 件の上書きを書き込む。`status` が `null` のときはその Concept の上書きを取り消し、
 * 自動算出の値へ戻す。
 */
export async function writeOverride(
  kv: KVNamespace,
  conceptId: string,
  status: MasteryStatus | null,
  now: () => string = () => new Date().toISOString(),
): Promise<MasteryOverrides> {
  const overrides = await readOverrides(kv);
  if (status === null) delete overrides[conceptId];
  else overrides[conceptId] = { status, updatedAt: now() };
  await kv.put(OVERRIDES_KEY, JSON.stringify(overrides));
  return overrides;
}

/**
 * 受け取った本文を検証する。不正な値を既定値へ倒さず、理由付きで弾く
 * （.agents/rules/rules.md RULE-004）。
 */
export function parseOverrideRequest(
  payload: unknown,
): { conceptId: string; status: MasteryStatus | null } | { error: string } {
  if (typeof payload !== "object" || payload === null) return { error: "invalid request body" };
  const { conceptId, status } = payload as { conceptId?: unknown; status?: unknown };
  if (typeof conceptId !== "string" || conceptId === "") {
    return { error: "conceptId must be a non-empty string" };
  }
  if (status === null) return { conceptId, status: null };
  if (!isMasteryStatus(status)) {
    return { error: `status must be one of ${MASTERY_STATUSES.join(", ")} or null` };
  }
  return { conceptId, status };
}
