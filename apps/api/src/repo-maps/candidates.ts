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
import { AI_USAGE_LIMITS } from "../contract/ai-usage.js";
import { AiSession, AiStageFailure, MAX_AI_CALLS_PER_DRAFT } from "./ai.js";
import {
  buildCandidatesPrompt,
  byteLength,
  CANDIDATE_MATERIAL_BYTES,
  CANDIDATE_SCHEMA_BYTES,
  headBytes,
} from "./prompts.js";
import type { DraftStage, DraftStatus } from "./repository.js";
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

// ノードの表示名（40）・概要（200）に、そのまま入る長さにする。確定で黙って切らないため。
// 概要は説明に「（原文: ○○）」を足すので、説明と原文の名前は短めにする。
const MAX_NAME = 40;
const MAX_ORIGINAL = 40;
const MAX_DESCRIPTION = 140;

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
  // 確定済みの下書きは、材料を消している。作り直しも、候補の再作成もできない。
  if (draft.confirmedMapId !== null && input.rebuild) {
    throw new RepoMapRefusal("conflict", "この下書きは確定済みです。", {
      mapId: draft.confirmedMapId,
    });
  }
  if (draft.status === "candidates" && !input.rebuild) return draftView(draft);
  // 作り直しは、候補を出したあとだけ。最初の 1 回で作り直しの回数を使わせない。
  if (input.rebuild && draft.status === "summarized") {
    throw new RepoMapRefusal("conflict", "先に候補を作ってください。", { status: draft.status });
  }
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

  // 設定の誤り（モデルが許可されていない・空）は、占有を取る前に断る。占有したまま残さない。
  const ai = new AiSession(
    { ...aiConfig, models: aiConfig.candidateModels ?? aiConfig.models },
    Math.max(0, MAX_AI_CALLS_PER_DRAFT - draft.aiCalls),
  );

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
  const release = (status: DraftStatus, next: FetchedState, extra = {}) =>
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

    // 文書が薄いかは、残した（外していない）文書の元のファイルの大きさで見る（要約の長さではなく）。
    const sizeOf = new Map(state.files.map((f) => [f.path, f.size]));
    const docBytes = materials
      .filter((m) => m.kind === "doc" || m.kind === "glossary")
      .reduce((n, m) => n + (sizeOf.get(m.ref) ?? 0), 0);
    const thin = docBytes < THIN_DOC_BYTES;

    // データの形の名前は、文書が薄いときだけ AI へ渡す（docs/data-privacy.md）。薄くなければ、
    // 名前のつき合わせと根拠は機械だけで行う。入る行だけを、丸ごと渡す（行の途中で切らない）。
    const schemaLines = thin
      ? schema.map((f) => ({ id: f.id, text: `[${f.id}] ${f.path}: ${f.names.join(", ")}` }))
      : [];
    while (
      schemaLines.length > 0 &&
      byteLength(schemaLines.map((l) => l.text).join("\n")) > CANDIDATE_SCHEMA_BYTES
    ) {
      schemaLines.pop();
    }
    const schemaText = schemaLines.map((l) => l.text).join("\n");

    // 入力の上限（バイト）に収める。材料は、入る行だけを丸ごと渡す。AI が見ていない材料の ID は、
    // 根拠として受けない（見ていないものを根拠にした候補を作らない）。
    const materialLines = materials.map((m) => ({
      id: m.id,
      text: `[${m.id}] ${m.kind} ${m.ref}: ${m.text}`,
    }));
    const build = (lines: readonly { text: string }[]) =>
      buildCandidatesPrompt({
        materials: lines.map((l) => l.text).join("\n"),
        schema: schemaText,
        thin,
        max: MAX_CANDIDATES,
        materialsMaxBytes: Number.POSITIVE_INFINITY,
      });
    const fits = (lines: readonly { text: string }[]) =>
      byteLength(lines.map((l) => l.text).join("\n")) <= CANDIDATE_MATERIAL_BYTES &&
      byteLength(build(lines)) <= AI_USAGE_LIMITS.inputTokensPerRequest;
    const sentMaterials = [...materialLines];
    while (sentMaterials.length > 0 && !fits(sentMaterials)) sentMaterials.pop();
    if (sentMaterials.length === 0 && materialLines.length > 0) {
      // 1 行も入らない（長すぎる 1 件）。先頭の 1 件だけを切って渡す。
      const first = materialLines[0]!;
      sentMaterials.push({ id: first.id, text: headBytes(first.text, CANDIDATE_MATERIAL_BYTES) });
    }
    const prompt = build(sentMaterials);
    const seenIds = new Set([...sentMaterials.map((l) => l.id), ...schemaLines.map((l) => l.id)]);
    const value = await ai.json("candidates", "candidates", prompt, {
      maxOutputTokens: CANDIDATES_MAX_OUTPUT_TOKENS,
      thinkingBudget: CANDIDATES_THINKING_BUDGET,
    });
    const raw = parseCandidates(value);

    // 根拠は、AI へ実際に渡した材料の ID だけを受ける。根拠が 1 つも無い候補は、裏付けが無いので外す。
    const allowed = seenIds;
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
      const matched = schemaNames.filter((s) =>
        names.some((n) => sameName(normalizeName(s.name), n)),
      );
      const fromSchema = matched.length > 0;
      // 一致したデータの形のファイルを根拠に足す（機械で。AI が答えたかどうかに依らない）。
      for (const m of matched) if (!evidence.includes(m.id)) evidence.push(m.id);
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
    // AI の候補に当たらない、データの形の名前を足す（機械で。AI は使わない）。文書・コードに無いとは言わない。
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
          "データの形（テーブル・モデル）に現れる名前です。AI の候補には選ばれなかったので、機械で足しました。",
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
      error instanceof RepoMapRefusal
        ? // 回数の上限などの断り。下書きの状態は何も変わっていないので、前の状態へ戻す。
          release(
            draft.status,
            state,
            draft.status === "failed"
              ? { failedStage: draft.failedStage, failureCode: draft.failureCode }
              : {},
          )
        : draft.status === "candidates"
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
