import { spawn } from "node:child_process";

import type {
  AnalysisInput,
  AnalysisProvider,
  EvidenceKind,
  HistoryAnalysisResult,
  HistoryObservation,
  RawConversation,
} from "@gakushu-sochi/domain";

import { describeApiFailure } from "../api-error.js";

/**
 * 履歴分析を担う Provider の実装（Issue #157）。
 *
 * - `createLocalRuleProvider`（local-rules.ts）: 常に使える第一候補。
 * - `createCliAnalysisProvider`: 利用者自身がインストールした CLI
 *   （codex / claude）を叩く。API キーはこのアプリには置かず、
 *   CLI 側の認証に委ねる。
 * - `createManagedAnalysisProvider`: API Server 経由の Managed AI。
 *   契約は `apps/api/src/contract/history-import.ts`。
 *
 * どの経路でも、返すのは構造化した観測だけ。本文や回答の自由文は
 * ここから先へ流さない。
 */

const EVIDENCE_KINDS: readonly EvidenceKind[] = [
  "question",
  "debugging",
  "explanation",
  "implementation",
  "verification",
];

export class AnalysisProviderError extends Error {
  readonly code: "rate_limited" | "request_failed" | "invalid_response" | "cli_failed";

  constructor(code: AnalysisProviderError["code"], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AnalysisProviderError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// プロンプト（CLI / prompt-copy fallback で共用）
// ---------------------------------------------------------------------------

/**
 * 分析プロンプト。API 側 `buildHistoryAnalysisPrompt`（apps/api/src/routes/ai.ts）
 * と同じ出力契約を要求する。利用者が自身の AI へ貼る fallback でもこの
 * プロンプトを使い、貼り戻された JSON は parseAnalysisOutput が検証する。
 */
export function buildAnalysisPrompt(input: AnalysisInput): string {
  const lines = input.conversations.map((conversation) =>
    [
      `--- conversation ${conversation.sourceId} ---`,
      conversation.title === undefined ? "" : `title: ${conversation.title}`,
      conversation.observedAt === undefined ? "" : `observedAt: ${conversation.observedAt}`,
      conversation.body,
    ]
      .filter((line) => line.length > 0)
      .join("\n"),
  );
  return [
    "あなたは学習履歴の分析器です。以下の会話履歴を読み、各会話で学習者が触れた概念を抽出してください。",
    '出力は JSON オブジェクト1つだけで、{"observations": [...]} の形にしてください。',
    "observations の各要素は次の形です:",
    '{ "sourceId": "会話のID（入力のものをそのまま）", "conceptCandidates": ["概念の候補"], "kind": "question|debugging|explanation|implementation|verification", "confidence": 0.0〜1.0, "observedAt": "ISO 8601（分かれば）" }',
    "conceptCandidates には、分かる場合は次の既知の Concept ID を使ってください:",
    input.knownConceptIds.join(", "),
    '一覧に合うものが無い場合は、無理に当てはめず短い名前（例: "kubernetes"）をそのまま返してください。',
    "1会話につき観測は最大3件まで。プログラミングと無関係な会話からは観測を作らないでください。",
    "",
    ...lines,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 出力の検証
// ---------------------------------------------------------------------------

function isObservation(value: unknown): value is HistoryObservation {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.sourceId !== "string" || candidate.sourceId.length === 0) return false;
  if (
    !Array.isArray(candidate.conceptCandidates) ||
    candidate.conceptCandidates.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    return false;
  }
  if (
    typeof candidate.kind !== "string" ||
    !EVIDENCE_KINDS.includes(candidate.kind as EvidenceKind)
  ) {
    return false;
  }
  if (
    typeof candidate.confidence !== "number" ||
    !Number.isFinite(candidate.confidence) ||
    candidate.confidence < 0 ||
    candidate.confidence > 1
  ) {
    return false;
  }
  if (candidate.observedAt !== undefined && typeof candidate.observedAt !== "string") return false;
  if (candidate.externalRefHash !== undefined && typeof candidate.externalRefHash !== "string") {
    return false;
  }
  return true;
}

/**
 * AI の出力テキストから `{observations: [...]}` を取り出して検証する。
 *
 * コードフェンスや前後の説明文は剥がすが、JSON として解釈できない、
 * observations 配列が無い場合は失敗として投げる（RULE-004）。
 * 構造の合わない観測は落とし、件数を `droppedObservations` に残す。
 */
export function parseAnalysisOutput(text: string): HistoryAnalysisResult {
  let trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) trimmed = (fence[1] ?? "").trim();
  if (!trimmed.startsWith("{")) {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new AnalysisProviderError(
        "invalid_response",
        "分析結果が JSON オブジェクトとして読めませんでした。",
      );
    }
    trimmed = trimmed.slice(start, end + 1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (cause) {
    throw new AnalysisProviderError("invalid_response", "分析結果の JSON 解析に失敗しました。", {
      cause,
    });
  }
  const observations = (parsed as { observations?: unknown }).observations;
  if (!Array.isArray(observations)) {
    throw new AnalysisProviderError(
      "invalid_response",
      "分析結果に observations 配列がありません。",
    );
  }
  const valid: HistoryObservation[] = [];
  let dropped = 0;
  for (const item of observations) {
    if (isObservation(item)) valid.push(item);
    else dropped += 1;
  }
  return { observations: valid, droppedObservations: dropped };
}

// ---------------------------------------------------------------------------
// CLI Provider（codex / claude 等、利用者がインストールしたツール）
// ---------------------------------------------------------------------------

export interface CliRunResult {
  stdout: string;
}

/** コマンド実行の差し替え口。本番は spawn、テストは偽物を渡す。 */
export interface CliRunner {
  run(
    command: string,
    args: readonly string[],
    input: string,
    timeoutMs: number,
  ): Promise<CliRunResult>;
}

export interface CliSpec {
  /** Provider の ID。ログと診断に出す。 */
  id: string;
  command: string;
  versionArgs: readonly string[];
  analyzeArgs: readonly string[];
  /** 1回の分析に許す実行時間。 */
  timeoutMs: number;
}

export const CLI_SPECS: readonly CliSpec[] = [
  {
    id: "codex-cli",
    command: "codex",
    versionArgs: ["--version"],
    // `codex exec` はプロンプトを stdin から読める（- で stdin）。
    analyzeArgs: ["exec", "-"],
    timeoutMs: 120_000,
  },
  {
    id: "claude-cli",
    command: "claude",
    versionArgs: ["--version"],
    // `claude -p` は引数なしなら stdin のプロンプトを処理する。
    analyzeArgs: ["-p"],
    timeoutMs: 120_000,
  },
];

/** spawn による既定の CLI 実行。出力は stdout だけを使い、stderr は捨てる。 */
export function createSpawnRunner(): CliRunner {
  return {
    run(command, args, input, timeoutMs) {
      return new Promise<CliRunResult>((resolve, reject) => {
        const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "ignore"] });
        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          reject(
            new AnalysisProviderError(
              "cli_failed",
              `${command} が ${Math.round(timeoutMs / 1000)} 秒以内に応答しませんでした。`,
            ),
          );
        }, timeoutMs);
        const chunks: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          const stdout = Buffer.concat(chunks).toString("utf8");
          if (code !== 0) {
            reject(
              new AnalysisProviderError(
                "cli_failed",
                `${command} が終了コード ${String(code)} で失敗しました。`,
              ),
            );
            return;
          }
          resolve({ stdout });
        });
        child.stdin.on("error", () => {
          // 書き込み側のエラー（EPIPE 等）は close/error で拾われるため、
          // ここで二重に reject しない。
        });
        child.stdin.end(input);
      });
    },
  };
}

/**
 * 利用者が入れた CLI を叩く Provider。
 *
 * isAvailable は `--version` の成否で判定する。見つからない
 * （spawn が ENOENT で失敗する）のは「利用不可」の正常系であり、
 * 失敗を例外で表に出す必要はない。
 */
export function createCliAnalysisProvider(spec: CliSpec, runner: CliRunner): AnalysisProvider {
  return {
    id: spec.id,
    async isAvailable() {
      try {
        await runner.run(spec.command, spec.versionArgs, "", 10_000);
        return true;
      } catch {
        return false;
      }
    },
    async analyze(input) {
      const prompt = buildAnalysisPrompt(input);
      let result: CliRunResult;
      try {
        result = await runner.run(spec.command, spec.analyzeArgs, prompt, spec.timeoutMs);
      } catch (error) {
        if (error instanceof AnalysisProviderError) throw error;
        throw new AnalysisProviderError("cli_failed", `${spec.command} の実行に失敗しました。`, {
          cause: error,
        });
      }
      return parseAnalysisOutput(result.stdout);
    },
  };
}

// ---------------------------------------------------------------------------
// Managed Provider（API Server 経由）
// ---------------------------------------------------------------------------

export interface ManagedProviderDeps {
  /** `${apiBaseUrl}/v1` まで。末尾スラッシュ無しを呼び出し側で保証する。 */
  baseUrl: string;
  getAccessToken: () => Promise<string>;
  fetch: typeof fetch;
  /** テストで差し替えるタイムアウト。既定は RULE-001 に従い必ず設定する。 */
  timeoutMs?: number;
}

// サーバー側の上流 AI 呼び出しは 120 秒まで待つ（apps/api/routes/ai.ts）。
// クライアントが先に切ると予約した利用枠だけが消費されるため、
// こちらはそれより長く待つ。
const MANAGED_ANALYSIS_TIMEOUT_MS = 150_000;

interface HistoryAnalysisResponseBody {
  observations: unknown;
  droppedObservations: number;
}

export function createManagedAnalysisProvider(deps: ManagedProviderDeps): AnalysisProvider {
  return {
    id: "managed",
    async isAvailable() {
      // ログイン済み（トークンが取れる）なら使える。利用枠の残量は
      // Router の予算管理とサーバー側の 429 でカバーする。
      try {
        await deps.getAccessToken();
        return true;
      } catch {
        return false;
      }
    },
    async analyze(input) {
      const token = await deps.getAccessToken();
      const response = await deps.fetch(`${deps.baseUrl}/ai/history-analysis`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        // 資格情報を載せたまま転送先へ流さない（RULE-002）。
        redirect: "error",
        signal: AbortSignal.timeout(deps.timeoutMs ?? MANAGED_ANALYSIS_TIMEOUT_MS),
        body: JSON.stringify({
          conversations: input.conversations.map((conversation: RawConversation) => ({
            sourceId: conversation.sourceId,
            ...(conversation.observedAt === undefined
              ? {}
              : { observedAt: conversation.observedAt }),
            ...(conversation.title === undefined ? {} : { title: conversation.title }),
            body: conversation.body,
            ...(conversation.externalRefHash === undefined
              ? {}
              : { externalRefHash: conversation.externalRefHash }),
          })),
          knownConceptIds: [...input.knownConceptIds],
        }),
      });
      const bodyText = await response.text();
      if (!response.ok) {
        let body: unknown;
        try {
          body = JSON.parse(bodyText);
        } catch {
          body = undefined;
        }
        const message = describeApiFailure(response.status, body);
        if (response.status === 429) {
          throw new AnalysisProviderError("rate_limited", message);
        }
        throw new AnalysisProviderError("request_failed", message);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyText);
      } catch (cause) {
        // 2xx で本文が読めないのは失敗。空の観測に置き換えない（RULE-004）。
        throw new AnalysisProviderError(
          "invalid_response",
          "Managed AI の応答を解析できませんでした。",
          { cause },
        );
      }
      const body = parsed as Partial<HistoryAnalysisResponseBody>;
      if (!Array.isArray(body.observations)) {
        throw new AnalysisProviderError(
          "invalid_response",
          "Managed AI の応答に observations がありません。",
        );
      }
      const valid: HistoryObservation[] = [];
      let dropped = typeof body.droppedObservations === "number" ? body.droppedObservations : 0;
      for (const item of body.observations) {
        if (isObservation(item)) valid.push(item);
        else dropped += 1;
      }
      return { observations: valid, droppedObservations: dropped };
    },
  };
}
