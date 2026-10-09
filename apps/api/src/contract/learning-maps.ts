/**
 * `/v1/learning-maps` の外部契約（Issue #242 / Web/18）。
 *
 * 利用者が手で作る、木の形の学習マップ。ノードは Concept で、線は「前提 → 次」を表す。
 * 保存の形は migrations/0013_learning_maps.sql。
 *
 * 契約はこのアプリに置く（apps/api/AGENTS.md）。
 */

import * as v from "valibot";
import { CHECK_LEVELS, CONCEPT_ID_PATTERN, type PersonalConceptCheck } from "@gakushu-sochi/domain";

/** 1人が持てるマップの数。 */
export const MAX_MAPS_PER_USER = 20;
/** 1マップのノード数。 */
export const MAX_NODES_PER_MAP = 50;
/**
 * 1マップの線の数（入力の大きさの上限）。前提は1つのノードにつき1つまで（#242 の
 * 2026-10-07 の決定）なので、実際に保存できる線はノード数 − 1 本までになる。
 */
export const MAX_EDGES_PER_MAP = MAX_NODES_PER_MAP;
export const MAX_MAP_TITLE_LENGTH = 80;
export const MAX_MAP_DESCRIPTION_LENGTH = 400;
export const MAX_NODE_LABEL_LENGTH = 40;
export const MAX_NODE_SUMMARY_LENGTH = 200;
/** 1ノードの「理解すること」の項目数。 */
export const MAX_OBJECTIVES_PER_NODE = 8;
export const MAX_OBJECTIVE_LABEL_LENGTH = 80;
/**
 * VS Code へ渡すノードの合計。AI へ渡す「既知の概念一覧」に入るので、
 * プロンプトの長さを抑えるために絞る。`GET /v1/learning-maps:concepts` の既定の件数。
 */
export const MAX_CLIENT_CONCEPTS = 100;
/**
 * 1人が持てるノード（参照ではないもの）の最大数。`:concepts` の `limit` の上限。
 * Web の編集画面は参照で足す候補として全部読む（100 件で切ると古いマップのノードを足せない）。
 */
export const MAX_OWN_NODES = MAX_MAPS_PER_USER * MAX_NODES_PER_MAP;

/**
 * 新しいノードの仮の番号。`new:` で始める。
 *
 * Concept ID（`<領域>.<識別子>`）はコロンを含まないので、既存のノードの ID と衝突しない。
 * サーバーが ID を振り、応答の `assigned` で仮の番号との対応を返す。
 */
export const NEW_NODE_REF_PATTERN = /^new:[A-Za-z0-9_-]{1,32}$/;

/** 前後の空白を落としたうえで、空でなく上限以内の文字列。 */
function text(max: number) {
  return v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(max));
}

/**
 * そのマップのノード。`ref` は既存のノードなら Concept ID、新しいノードなら仮の番号。
 * 概要は必須（確認問題の生成の入力になるため）。
 */
const ownNodeSchema = v.strictObject({
  kind: v.literal("own"),
  ref: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  label: text(MAX_NODE_LABEL_LENGTH),
  summary: text(MAX_NODE_SUMMARY_LENGTH),
});

/**
 * 既存の Concept への参照。固定の Concept か、自分の他のマップのノードを元の ID のまま置く。
 * 表示名・概要・「理解すること」は元のものを使うので、ここでは受け取らない。
 */
const referenceNodeSchema = v.strictObject({
  kind: v.literal("reference"),
  conceptId: v.pipe(v.string(), v.regex(CONCEPT_ID_PATTERN)),
});

/**
 * 線は、ノードの `ref`（参照のノードなら `conceptId`）どうしを結ぶ。
 * `from` が前提、`to` が次。
 */
const edgeSchema = v.strictObject({
  from: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  to: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
});

/**
 * `POST /v1/learning-maps` と `PUT /v1/learning-maps/:id` が受け取るマップの中身。
 *
 * PUT はノードと線を**まとめて置き換える**。送らなかったノードは消える。
 * `strictObject` は知らないキーを黙って捨てないためである（contract/conversations.ts と同じ）。
 */
export const learningMapContentSchema = v.strictObject({
  title: text(MAX_MAP_TITLE_LENGTH),
  description: v.optional(
    v.pipe(v.string(), v.trim(), v.maxLength(MAX_MAP_DESCRIPTION_LENGTH)),
    "",
  ),
  nodes: v.optional(
    v.pipe(
      v.array(v.variant("kind", [ownNodeSchema, referenceNodeSchema])),
      v.maxLength(MAX_NODES_PER_MAP),
    ),
    [],
  ),
  edges: v.optional(v.pipe(v.array(edgeSchema), v.maxLength(MAX_EDGES_PER_MAP)), []),
});

export type LearningMapContentInput = v.InferOutput<typeof learningMapContentSchema>;

/**
 * `PUT /v1/learning-maps/:id/nodes/:conceptId/objectives` が受け取る「理解すること」。
 *
 * 一覧をまとめて置き換える。既存の項目は `id` を付けて送り、新しい項目は `id` を省く
 * （サーバーが `<Concept ID>:<識別子>` を振る）。送らなかった項目は消える。
 * 並びは送った順になる。
 */
export const learningObjectivesInputSchema = v.strictObject({
  objectives: v.pipe(
    v.array(
      v.strictObject({
        id: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
        label: text(MAX_OBJECTIVE_LABEL_LENGTH),
      }),
    ),
    v.maxLength(MAX_OBJECTIVES_PER_NODE),
  ),
});

export type LearningObjectivesInput = v.InferOutput<typeof learningObjectivesInputSchema>;

/**
 * 共有の範囲（#244 の決定 T5）。`link` は「リンクを知っている人だけ」、`public` は「全員（一覧に出す）」。
 * `private` は持ち主だけ。マップは最初は `private` で、版を上げて共有へ切り替える。
 */
export const SHARE_SCOPES = ["link", "public"] as const;
export type ShareScope = (typeof SHARE_SCOPES)[number];
export type LearningMapVisibility = "private" | ShareScope;
export type LearningObjectiveSource = "manual" | "ai";

/** 「理解すること」の1項目。 */
export interface LearningObjectiveView {
  id: string;
  label: string;
  source: LearningObjectiveSource;
}

/** 参照のノードが指している元の Concept。 */
export interface ReferencedConcept {
  label: string;
  /** 固定の Concept は概要を持たないことがある（`Concept.summary` が任意）。 */
  summary?: string;
  /** 元が自分の他のマップのノードならそのマップの ID。固定の Concept なら `null`。 */
  mapId: string | null;
  objectives: LearningObjectiveView[];
}

export type LearningMapNodeView =
  | {
      kind: "own";
      conceptId: string;
      label: string;
      summary: string;
      objectives: LearningObjectiveView[];
    }
  | {
      kind: "reference";
      conceptId: string;
      /**
       * 元の Concept。元のマップやノードが消えていて引けなければ `null`。
       * 参照のノードはそのまま残し、表示側で「元が見つからない」と出す。
       */
      origin: ReferencedConcept | null;
    };

export interface LearningMapEdge {
  from: string;
  to: string;
}

/** 取り込み元（#244 の T3・T4）。 */
export interface MapSourceView {
  mapId: string;
  /** 取り込んだ時点の元の題名。 */
  title: string;
  /** 取り込んだ（取り込み直した）版。 */
  version: number;
  /**
   * 今読める元のいちばん新しい版。これが `version` より新しければ「更新あり」。
   * 元が消えた・共有をやめた・リンクの鍵を作り直したなら `null`（もう取り込み直せない）。
   */
  latestVersion: number | null;
}

/** 一覧の1件。ノードと線は含めない。 */
export interface LearningMapSummary {
  id: string;
  title: string;
  description: string;
  visibility: LearningMapVisibility;
  /** 共有の側のいちばん新しい版の番号。まだ一度も上げていなければ `null`。 */
  latestVersion: number | null;
  /** 取り込んだマップ（個人マップ）なら取り込み元（#244 の T3）。そうでなければ `null`。 */
  source: MapSourceView | null;
  nodeCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * 作成時の確認問題の状態（#247）。
 *
 * - `pending`: まだ作っていない（または1回失敗した）。`checks:generate` で作れる。
 * - `done`: 作成済み。
 * - `exhausted`: 頼める回数を使い切った（全部失敗した）。
 */
export type CreationChecksStatus = "pending" | "done" | "exhausted";

/** `GET /v1/learning-maps/:id` の応答。ノードは保存した順（学習の順）に並ぶ。 */
export interface LearningMapView extends Omit<LearningMapSummary, "nodeCount"> {
  /**
   * 範囲が「リンクだけ」のときの鍵（#244 の決定 U1）。持ち主だけが受け取り、
   * `/maps/<マップ ID>?key=<鍵>` のリンクを組み立てる。ほかの範囲では `null`。
   */
  shareKey: string | null;
  nodes: LearningMapNodeView[];
  edges: LearningMapEdge[];
  /** AI で作るときに「確認問題も作る」を選んだマップだけが持つ（#247）。 */
  creationChecks?: { status: CreationChecksStatus };
}

/** `GET /v1/learning-maps` の応答。更新の新しい順。 */
export interface ListLearningMapsResponse {
  maps: LearningMapSummary[];
}

/**
 * `POST` と `PUT` の応答。`assigned` は新しいノードの仮の番号と、振った Concept ID の対応。
 */
export interface SaveLearningMapResponse {
  map: LearningMapView;
  assigned: Record<string, string>;
}

/** `PUT .../objectives` の応答。保存後の一覧。 */
export interface PutLearningObjectivesResponse {
  objectives: LearningObjectiveView[];
}

/** `GET /v1/learning-maps:concepts` の1件。VS Code が「既知の概念一覧」に加える。 */
export interface ClientMapConcept {
  id: string;
  label: string;
  summary: string;
  mapId: string;
  mapTitle: string;
  /** 前提のノードの Concept ID。参照のノード（固定の Concept など）も含む。 */
  prerequisites: string[];
  objectives: { id: string; label: string }[];
}

export interface ListClientMapConceptsResponse {
  concepts: ClientMapConcept[];
  /**
   * 固定の Concept（言語別マップ）の「理解すること」（#245）。VS Code が理解度の導出と
   * プロンプトに使う。`limit` に関係なく全件。
   */
  fixedObjectives: { id: string; conceptId: string; label: string }[];
}

/**
 * AI で作るマップの種類（#243）。
 *
 * - `field`: 分野の全体マップ。言語や技術の名前から、基礎から応用までの木を作る。
 * - `goal`: 目標までのマップ。テーマと目標から、そこへ至る道筋の木を作る。
 */
export const MAP_GENERATION_KINDS = ["field", "goal"] as const;
export type MapGenerationKind = (typeof MAP_GENERATION_KINDS)[number];

/**
 * AI で作るマップのノード数の上限（#243 の 2026-10-08 の決定）。手で作る上限
 * （{@link MAX_NODES_PER_MAP}）より小さい。生成のトークンを 5 回分の上界に収めるため。
 */
export const MAX_GENERATED_NODES = 30;
/** AI が作る1ノードの「理解すること」の数。範囲から外れた応答は受理しない。 */
export const MIN_GENERATED_OBJECTIVES = 2;
export const MAX_GENERATED_OBJECTIVES = 5;
/** 1マップの生成で `ai_usage` から引く回数。内部で AI を何回呼ぶかにかかわらない。 */
export const MAP_GENERATION_USAGE_COST = 5;
export const MAX_GENERATION_THEME_LENGTH = 80;
export const MAX_GENERATION_GOAL_LENGTH = 400;

/**
 * `POST /v1/learning-maps:generate` が受け取るもの。
 *
 * 目標（`goal`）は目標までのマップでだけ受け取り、そこでは必須にする。
 * 分野の全体マップで目標を受け取ると、どちらの種類の木を作るのかが曖昧になる。
 */
export const generateLearningMapSchema = v.pipe(
  v.strictObject({
    kind: v.picklist(MAP_GENERATION_KINDS),
    theme: text(MAX_GENERATION_THEME_LENGTH),
    goal: v.optional(text(MAX_GENERATION_GOAL_LENGTH)),
    level: v.picklist(CHECK_LEVELS),
    /**
     * 作ったあとに確認問題も作るか（#247）。既定は作る。`true` なら、マップを保存したあと
     * `POST /v1/learning-maps/:id/checks:generate` で作れる（回数はさらに 5 回分）。
     */
    checks: v.optional(v.boolean(), true),
    /** 生成の画面でその場で同意した文面の版。「今後表示しない」の記録があれば省略できる。 */
    consentVersion: v.optional(v.pipe(v.number(), v.integer())),
  }),
  v.check(
    (input) => (input.kind === "goal") === (input.goal !== undefined),
    'goal is required for kind "goal" and not allowed for kind "field"',
  ),
);

export type GenerateLearningMapInput = v.InferOutput<typeof generateLearningMapSchema>;

/** `POST /v1/learning-maps:generate` の応答。作って保存したマップ。 */
export interface GenerateLearningMapResponse {
  map: LearningMapView;
}

/** `GET /v1/map-generation-consent` の応答（`/v1/check-generation-consent` と同じ形）。 */
export interface MapGenerationConsentBody {
  /** 今の文面の版。クライアントは同意したときにこの値を送る。 */
  version: number;
  /** 今の版で「今後表示しない」を選んでいるか。古い版の記録は false。 */
  granted: boolean;
  grantedAt?: string;
}

/** `POST /v1/learning-maps/:id/checks:generate` の応答（#247）。 */
export interface GenerateCreationChecksResponse {
  /** 保存できた組。 */
  checks: PersonalConceptCheck[];
  /** 頼んだが作れなかった組の数（上流の失敗・形式の逸脱・生成中の削除）。 */
  failedCount: number;
  /** 入力の上限や回数分のトークンに収まらず、頼まなかった組の数。 */
  skippedCount: number;
}

/**
 * 共有の版の中身を表示する形（#244）。ノードは {@link LearningMapView} と同じ形で、
 * 確認画面・履歴・持ち主以外の表示が同じ部品で描ける。
 *
 * 参照のノードの `origin.mapId` は、持ち主以外から元のマップが見えないので常に `null`。
 * `checks` は共有に含めた作成時の確認問題（#247 の `origin = map_creation`）。
 */
export interface SharedMapContentView {
  title: string;
  description: string;
  nodes: LearningMapNodeView[];
  edges: LearningMapEdge[];
  checks: PersonalConceptCheck[];
}

/** 差分で変わったところ。前提は1つのノードにつき1つまで（#242）なので1つで比べる。 */
export type MapNodeChangeField = "kind" | "label" | "summary" | "prerequisite" | "objectives";

export interface MapNodeChange {
  conceptId: string;
  fields: MapNodeChangeField[];
  before: LearningMapNodeView;
  after: LearningMapNodeView;
  /** 前提のノードの Concept ID。無ければ `null`。 */
  prerequisiteBefore: string | null;
  prerequisiteAfter: string | null;
}

/**
 * 2つの版（または手元のマップと版）の差分（#244）。確認画面と、取り込み直しの差分に使う。
 * 並びは `after` のノードの順（消えたノードは `before` の順）。
 */
export interface LearningMapDiff {
  title: { before: string; after: string } | null;
  description: { before: string; after: string } | null;
  added: LearningMapNodeView[];
  removed: LearningMapNodeView[];
  changed: MapNodeChange[];
  /** 両方にあるノードの並び（学習の順）が変わったか。並びだけを変えても新しい版になる。 */
  reordered: boolean;
  /** 確認問題は Concept と狙いの組で比べ、中身が変わったものは消して足したものとして数える。 */
  checks: { added: PersonalConceptCheck[]; removed: PersonalConceptCheck[] };
}

/** 版の変更の要約。履歴の一覧に出す。 */
export interface MapVersionSummary {
  added: number;
  removed: number;
  changed: number;
  titleChanged: boolean;
  reordered: boolean;
  checksAdded: number;
  checksRemoved: number;
}

/** 履歴の1件。 */
export interface MapVersionMeta {
  version: number;
  createdAt: string;
  /** 上げた人の ID。持ち主なら画面は「自分」と出す。 */
  authorUserId: string;
  /** 復元で作った版なら、元の版番号。 */
  restoredFrom: number | null;
  checksIncluded: boolean;
  summary: MapVersionSummary;
}

/**
 * `GET /v1/learning-maps/:id/versions:preview` の応答。共有へ上げる前の確認画面（#244 の S1-a）。
 *
 * `content` は上げると出ていく中身の全部、`diff` はいちばん新しい版との差分（まだ版が無ければ
 * すべて「足した」）。`contentHash` を `POST .../versions` に添えると、確認したあとに手元が
 * 変わっていたら上げずに 409 を返す。
 */
export interface MapPublishPreview {
  visibility: LearningMapVisibility;
  latest: MapVersionMeta | null;
  includeChecks: boolean;
  /** 共有に含められる作成時の確認問題の数（含めないを選んでも数える）。 */
  availableChecks: number;
  content: SharedMapContentView;
  diff: LearningMapDiff;
  /** いちばん新しい版と中身が同じなら `false`（上げても新しい版にならない）。 */
  hasChanges: boolean;
  contentHash: string;
}

/** `POST /v1/learning-maps/:id/versions` が受け取るもの。 */
export const publishLearningMapSchema = v.strictObject({
  visibility: v.picklist(SHARE_SCOPES),
  includeChecks: v.boolean(),
  /** 確認画面で見た、いちばん新しい版の番号。まだ版が無ければ `null`。 */
  baseVersion: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
  /** 確認画面で見た中身の `contentHash`。 */
  contentHash: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
});

/** `PUT /v1/learning-maps/:id/visibility` が受け取るもの。共有の範囲だけを変え、版は作らない。 */
export const learningMapVisibilitySchema = v.strictObject({
  visibility: v.picklist(["private", ...SHARE_SCOPES]),
});

/** `POST /v1/learning-maps/:id/versions/:version/restore` が受け取るもの。 */
export const restoreLearningMapSchema = v.strictObject({
  /** 履歴の画面で見た、いちばん新しい版の番号。 */
  baseVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

/** `POST .../versions` と `.../restore` の応答。 */
export interface PublishLearningMapResponse {
  version: MapVersionMeta;
  visibility: LearningMapVisibility;
}

/** `GET /v1/learning-maps/:id/versions` の応答。新しい版から。 */
export interface ListMapVersionsResponse {
  versions: MapVersionMeta[];
}

/** `GET /v1/learning-maps/:id/versions/:version` の応答。 */
export interface MapVersionResponse {
  version: MapVersionMeta;
  content: SharedMapContentView;
}

/** 全員の一覧の1件（`GET /v1/shared-maps`）。題名・説明は共有の側のいちばん新しい版のもの。 */
export interface SharedMapSummary {
  id: string;
  title: string;
  description: string;
  nodeCount: number;
  version: number;
  publishedAt: string;
}

/** `GET /v1/shared-maps` の応答。新しく上げた順。作成者の名前は出さない（T5）。 */
export interface ListSharedMapsResponse {
  maps: SharedMapSummary[];
}

/** 全員の一覧に出す件数。評価・検索はスコープ外（#244）なので、新しいものから絞る。 */
export const MAX_LISTED_SHARED_MAPS = 50;

/**
 * `GET /v1/shared-maps/:id` の応答。共有の側のいちばん新しい版。
 * 持ち主以外には、確認問題は数だけを返す（解くのは取り込んでから、#250）。
 */
export interface SharedMapView {
  id: string;
  visibility: ShareScope;
  version: number;
  publishedAt: string;
  isOwner: boolean;
  title: string;
  description: string;
  nodes: LearningMapNodeView[];
  edges: LearningMapEdge[];
  checkCount: number;
  /**
   * フォーク（#246）なら、もとにしたマップ（決定 V3-a）。`mapId` は元が全員に共有されているときだけ
   * 持つ（リンクを付ける）。「リンクだけ」の元は題名だけ（元の鍵を出さない）。
   */
  forkedFrom?: { title: string; mapId: string | null };
}

/**
 * `POST /v1/learning-maps/:id/fork-checks:generate` が受け取るもの（#246 の V4-a）。
 * 取り込んだマップで、まだ公開の確認問題が無いノードの問題を作る。同意はマップを AI で作るときの同意。
 */
export const generateForkChecksSchema = v.strictObject({
  level: v.picklist(CHECK_LEVELS),
  /** その場で同意した文面の版。「今後表示しない」の記録があれば省略できる。 */
  consentVersion: v.optional(v.pipe(v.number(), v.integer())),
});

/** `POST /v1/shared-maps/:id/import` が受け取るもの。「リンクだけ」のマップはリンクの鍵が要る（U1）。 */
export const importSharedMapSchema = v.strictObject({
  key: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
});

/** `POST /v1/shared-maps/:id/import` の応答。作った個人マップ。 */
export interface ImportSharedMapResponse {
  map: LearningMapView;
}

/**
 * `GET /v1/learning-maps/:id/reimport:preview` の応答（#244 の T4）。
 *
 * `diff` は今の個人マップから、取り込み直したあとへの差分。`removed` には共有の側で消されたノード
 * だけが入る（既定は消す。`keep` に入れると残せる）。個人マップで足したノードはそのまま残るので入らない。
 * `changed` のノードは共有の側の中身で上書きされる。そのうち個人マップで直していたものを
 * `personallyEdited` に挙げる（直した分は消える）。
 */
export interface ReimportPreview {
  source: MapSourceView;
  latest: { version: number; publishedAt: string };
  /** 新しい版の中身（個人マップで足したノードと、残すノードは含まない）。 */
  content: SharedMapContentView;
  diff: LearningMapDiff;
  personallyEdited: string[];
  /** 読んだときの手元の書き換えの回数。取り込み直すときに添える。 */
  revision: number;
}

/** `POST /v1/learning-maps/:id/reimport` が受け取るもの。 */
export const reimportLearningMapSchema = v.strictObject({
  /** 差分で見た共有の側の版。 */
  version: v.pipe(v.number(), v.integer(), v.minValue(1)),
  /** 差分を見たときの手元の書き換えの回数。 */
  revision: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /** 共有の側で消されたノードのうち、残すもの。 */
  keep: v.pipe(
    v.array(v.pipe(v.string(), v.regex(CONCEPT_ID_PATTERN))),
    v.maxLength(MAX_NODES_PER_MAP),
  ),
});

/** `POST /v1/learning-maps/:id/reimport` の応答。取り込み直したあとの個人マップ。 */
export interface ReimportLearningMapResponse {
  map: LearningMapView;
}
