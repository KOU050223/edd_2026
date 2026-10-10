/**
 * 候補の段（#249 の PR C2b）。要約した材料と、機械で読んだデータの形の名前から、AI に用語の候補を出させる。
 *
 * - 入力は要約だけ（生のファイルは渡さない）。1 回の呼び出し
 * - 根拠は ID（`E1`・`S1`）で返させ、パスは機械で戻す（AI にパスを書かせると、短縮や誤記が出る）
 * - 「データの形にも現れる」の印は、AI の自己申告ではなく、名前のつき合わせで機械が付ける
 * - 文書にはなく、データの形にだけある名前は、「データの形にだけある」候補として機械で足す
 * - 文書が薄いときは、データの形の名前とコードの要約を主の材料にするよう頼む
 * - 作り直し（`rebuild`）は、外す材料を指定して、この段だけをやり直す（要約はやり直さない。1 日 5 回）
 */

import { utcDayKey, utcMonthKey } from "../contract/ai-usage.js";
import { REPO_MAP_LIMITS, type RepoMapDraftView } from "../contract/repo-maps.js";
import { AiSession, AiStageFailure, MAX_AI_CALLS_PER_DRAFT } from "./ai.js";
import {
  buildCandidatesPrompt,
  CANDIDATE_MATERIAL_BYTES,
  CANDIDATE_SCHEMA_BYTES,
  headBytes,
} from "./prompts.js";
import type { DraftStage } from "./repository.js";
import {
  draftView,
  parseState,
  RepoMapRefusal,
  requireConsent,
  type CandidateState,
  type FetchedState,
  type RepoMapDeps,
} from "./service.js";
import { CLAIM_LEASE_MS } from "./summarize.js";

/** 候補の数の上限（AI が返す分）。 */
export const MAX_CANDIDATES = 20;
/** 文書にはなく、データの形にだけある名前として足す候補の上限。 */
export const MAX_SCHEMA_ONLY = 5;
/** 用語集・README・docs の合計がこれより小さければ「文書が薄い」。固定値から始め、実測で調整する。 */
export const THIN_DOC_BYTES = 2_048;
/** 候補の出力上限と思考の上限（思考が出力を食って JSON が切れないよう絞る）。 */
export const CANDIDATES_MAX_OUTPUT_TOKENS = 4_096;
export const CANDIDATES_THINKING_BUDGET = 512;

const MAX_NAME = 60;
const MAX_ORIGINAL = 80;
const MAX_DESCRIPTION = 200;

/** 名前のつき合わせ用。英数字だけの小文字にする（`order_items` と `OrderItem` を同じ扱いにする）。 */
export function normalizeName(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** 単数・複数（末尾の s）の違いだけは同じ名前とみなす。 */
function sameName(a: string, b: string): boolean {
  return a !== "" && b !== "" && (a === b || a === `${b}s` || `${a}s` === b);
}

const unusable = (label: string) =>
  new AiStageFailure(
    "unusable",
    502,
    {
      error: "ai_response_unusable",
      reason: "shape",
      message: "AI の応答を読み取れませんでした。もう一度お試しください。",
    },
    `shape: ${label}`,
  );

interface RawCandidate {
  name: string;
  original: string;
  description: string;
  evidence: string[];
}

/** 応答の形を確かめる。1 件でも形が違えば受理しない（取れた分だけ使わない）。 */
function parseCandidates(value: unknown): RawCandidate[] {
  if (!Array.isArray(value)) throw unusable("candidates is not an array");
  return value.map((raw: unknown, i) => {
    const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
    if (
      o === null ||
      typeof o.name !== "string" ||
      o.name.trim() === "" ||
      o.name.length > MAX_NAME ||
      typeof o.description !== "string" ||
      o.description.length > MAX_DESCRIPTION ||
      (o.original !== undefined && o.original !== null && typeof o.original !== "string") ||
      (typeof o.original === "string" && o.original.length > MAX_ORIGINAL) ||
      !Array.isArray(o.evidence) ||
      !o.evidence.every((e) => typeof e === "string")
    ) {
      throw unusable(`candidate #${String(i)}`);
    }
    return {
      name: o.name.trim(),
      original: typeof o.original === "string" ? o.original.trim() : "",
      description: o.description.trim(),
      evidence: [...new Set(o.evidence as string[])],
    };
  });
}

function failureCodeOf(error: unknown): string {
  if (error instanceof AiStageFailure) return `ai_${error.kind}`;
  return "internal";
}

export async function buildCandidates(
  deps: RepoMapDeps,
  userId: string,
  draftId: string,
  input: { consentVersion?: number | undefined; excludeIds: readonly string[]; rebuild: boolean },
): Promise<RepoMapDraftView> {
  const now = deps.now();
  const draft = await deps.drafts.get(userId, draftId);
  if (draft === null || draft.expiresAt <= now.toISOString()) {
    throw new RepoMapRefusal("not_found", "下書きが見つかりません。", {});
  }
  // 済んでいる段は、作り直しでなければ、何も送らずに結果を返す。
  if (draft.status === "candidates" && !input.rebuild) return draftView(draft);
  const resumable =
    draft.status === "summarized" ||
    draft.status === "candidates" ||
    (draft.status === "failed" && draft.failedStage === "candidates");
  if (!resumable) {
    throw new RepoMapRefusal("conflict", "先に要約の段を終えてください。", {
      status: draft.status,
    });
  }
  const state = parseState(draft);
  const summary = state.summary;
  if (summary === undefined) {
    throw new Error(`repo map draft has no summary state (id=${draft.id})`);
  }

  // 外す材料の ID は、この下書きにあるものだけ。
  const schemaIds = summary.schema.map((_, i) => `S${String(i + 1)}`);
  const known = new Set([...summary.materials.map((m) => m.id), ...schemaIds]);
  for (const id of input.excludeIds) {
    if (!known.has(id)) {
      throw new RepoMapRefusal("invalid_target", `この下書きに無い材料です: ${id}`, { id });
    }
  }
  const excluded = new Set(input.excludeIds);
  const materials = summary.materials.filter((m) => !excluded.has(m.id));
  const schema = summary.schema
    .map((f, i) => ({ ...f, id: `S${String(i + 1)}` }))
    .filter((f) => !excluded.has(f.id));
  if (materials.length === 0 && schema.length === 0) {
    throw new RepoMapRefusal(
      "invalid_target",
      "材料が残っていません。外す材料を減らしてください。",
      {},
    );
  }

  // AI へ送る前に、同意（今の版）と、下書きごとの呼び出しの上限を確かめる。
  await requireConsent(deps, userId, input.consentVersion);
  if (draft.aiCalls >= MAX_AI_CALLS_PER_DRAFT) {
    throw new RepoMapRefusal(
      "quota_exceeded",
      "この下書きで使える AI の呼び出しの上限に達しました。新しい下書きを作ってください。",
      { limit: MAX_AI_CALLS_PER_DRAFT, used: draft.aiCalls },
    );
  }
  const aiConfig = deps.ai;
  if (aiConfig === undefined) {
    throw new AiStageFailure(
      "not_configured",
      503,
      { error: "ai_not_configured", message: "AI の設定に問題があります。" },
      "ai config missing",
    );
  }

  // 段の占有。同じ下書きの段を同時に走らせない。
  const claim = `claim:${String(now.getTime()).padStart(13, "0")}:${deps.newId()}`;
  const claimed = await deps.drafts.claimStage({
    userId,
    id: draftId,
    claim,
    nowMs: now.getTime(),
    leaseMs: CLAIM_LEASE_MS,
    statuses: ["summarized", "candidates", "failed"],
  });
  if (!claimed) {
    throw new RepoMapRefusal(
      "conflict",
      "この下書きは別の操作で処理中です。しばらくしてからもう一度お試しください。",
      {},
    );
  }
  const stageNow = now.toISOString();
  const monthKey = utcMonthKey(now);
  const dayKey = utcDayKey(now);
  // 占有を持ったあとの失敗は、占有を手放して状態を残す（持ったままにしない）。
  const release = (
    status: "summarized" | "candidates" | "failed",
    next: FetchedState,
    extra = {},
  ) =>
    deps.drafts.update(userId, draftId, {
      status,
      stageState: JSON.stringify(next),
      stageStateVersion: draft.stageStateVersion,
      failedStage: null,
      failureCode: null,
      updatedAt: stageNow,
      claim,
      ...extra,
    });

  const ai = new AiSession(
    { ...aiConfig, models: aiConfig.candidateModels ?? aiConfig.models },
    Math.max(0, MAX_AI_CALLS_PER_DRAFT - draft.aiCalls),
  );
  let flushAttempted = false;
  const flush = async () => {
    if (flushAttempted) return;
    flushAttempted = true;
    await deps.drafts.recordAiCalls({
      userId,
      draftId,
      monthKey,
      dayKey,
      updatedAt: stageNow,
      calls: ai.calls,
    });
  };

  try {
    if (input.rebuild) {
      const plan = await deps.plans.get(userId);
      const limit = REPO_MAP_LIMITS[plan].dailyRebuilds;
      const reserved = await deps.drafts.reserveRebuild({
        userId,
        monthKey,
        dayKey,
        updatedAt: stageNow,
        limit,
      });
      if (!reserved.reserved) {
        throw new RepoMapRefusal(
          "quota_exceeded",
          `今日に作り直せる回数（${String(limit)}）に達しました。`,
          { limit, used: reserved.usage.dailyRebuilds, kind: "rebuild" },
        );
      }
    }

    // 文書が薄いかは、元のファイルの大きさで見る（要約の長さではなく）。
    const docBytes = state.files
      .filter((f) => f.cls === "doc" || f.cls === "glossary")
      .reduce((n, f) => n + f.size, 0);
    const thin = docBytes < THIN_DOC_BYTES;

    const materialLines = materials.map((m) => `[${m.id}] ${m.kind} ${m.ref}: ${m.text}`);
    const schemaLines = schema.map((f) => `[${f.id}] ${f.path}: ${f.names.join(", ")}`);
    const prompt = buildCandidatesPrompt({
      materials: headBytes(materialLines.join("\n"), CANDIDATE_MATERIAL_BYTES),
      schema: headBytes(schemaLines.join("\n"), CANDIDATE_SCHEMA_BYTES),
      thin,
      max: MAX_CANDIDATES,
    });
    const value = await ai.json("candidates", "candidates", prompt, {
      maxOutputTokens: CANDIDATES_MAX_OUTPUT_TOKENS,
      thinkingBudget: CANDIDATES_THINKING_BUDGET,
    });
    const raw = parseCandidates(value);

    // 根拠は、残した材料の ID だけを受ける。根拠が 1 つも無い候補は、裏付けが無いので外す。
    const allowed = new Set([...materials.map((m) => m.id), ...schema.map((f) => f.id)]);
    const schemaNames = schema.flatMap((f) => f.names.map((n) => ({ name: n, id: f.id })));
    const seen = new Set<string>();
    const items: CandidateState[] = [];
    for (const c of raw) {
      const evidence = c.evidence.filter((id) => allowed.has(id));
      if (evidence.length === 0) continue;
      const key = normalizeName(c.original) || c.name;
      if (seen.has(key)) continue;
      seen.add(key);
      const names = [normalizeName(c.original), normalizeName(c.name)];
      const fromSchema = schemaNames.some((s) =>
        names.some((n) => sameName(normalizeName(s.name), n)),
      );
      items.push({
        id: `C${String(items.length + 1)}`,
        name: c.name,
        original: c.original,
        description: c.description,
        evidence,
        fromSchema,
        schemaOnly: false,
      });
      if (items.length >= MAX_CANDIDATES) break;
    }
    // 文書・コードには無く、データの形にだけある名前を足す（機械で。AI は使わない）。
    const covered = items.flatMap((c) => [normalizeName(c.original), normalizeName(c.name)]);
    let added = 0;
    for (const s of schemaNames) {
      if (added >= MAX_SCHEMA_ONLY) break;
      const n = normalizeName(s.name);
      if (n === "" || covered.some((c) => sameName(c, n))) continue;
      covered.push(n);
      added += 1;
      items.push({
        id: `C${String(items.length + 1)}`,
        name: s.name,
        original: s.name,
        description:
          "文書やコードの要約には出てこない、データの形（テーブル・モデル）にだけある名前です。",
        evidence: [s.id],
        fromSchema: true,
        schemaOnly: true,
      });
    }

    const next: FetchedState = {
      ...state,
      candidates: { items, thin, excluded: [...excluded] },
    };
    // 記録を先に書き、そのあとで状態を書く（完了の状態を、記録の失敗で巻き戻さない）。
    await flush();
    const written = await release("candidates", next);
    if (!written) throw new Error("repo map draft stage claim was lost");
  } catch (error) {
    // 課金された呼び出しを残し、占有を手放す。元の失敗を隠さない。
    await flush().catch((flushError: unknown) => {
      console.error("failed to record repo map ai calls", { draftId, flushError });
    });
    // 作り直しの失敗では、前の候補が今も有効なので、その状態へ戻す（失敗の段は書かない）。
    const stage: DraftStage = "candidates";
    const settle =
      draft.status === "candidates"
        ? release("candidates", state)
        : release("failed", state, { failedStage: stage, failureCode: failureCodeOf(error) });
    await settle.catch((updateError: unknown) => {
      console.error("failed to settle repo map draft after a failure", { draftId, updateError });
    });
    throw error;
  }

  const saved = await deps.drafts.get(userId, draftId);
  if (saved === null) throw new Error("repo map draft disappeared after candidates");
  return draftView(saved);
}
