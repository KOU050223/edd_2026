import { describe, expect, it } from "vitest";

import * as v from "valibot";

import { DEFAULT_SETTINGS, MANAGED_AI_MAX_OUTPUT_TOKENS } from "../settings.js";
import { desktopSettingsSchema, HISTORY_PROVIDER_IDS, INVOKE_SCHEMAS } from "./schemas.js";

const parse = (schema: v.GenericSchema, args: unknown[]) => v.safeParse(schema, args);

describe("INVOKE_SCHEMAS", () => {
  it("accepts empty argument tuples for no-argument channels and rejects extras", () => {
    for (const channel of [
      "settings:get",
      "auth:login",
      "auth:logout",
      "selection:retry",
      "answer:cancel",
      "conversation-history:get",
      "consent:status",
      "consent:review",
      "history:detect",
      "history:pick-file",
      "history:build-prompt",
      "history:list",
      "window:close",
      "window:minimize",
      "system:accessibility",
    ] as const) {
      expect(parse(INVOKE_SCHEMAS[channel], []).success, channel).toBe(true);
      expect(parse(INVOKE_SCHEMAS[channel], ["extra"]).success, channel).toBe(false);
    }
  });

  it("validates answer:ask as a two-string tuple", () => {
    expect(parse(INVOKE_SCHEMAS["answer:ask"], ["選択", "質問"]).success).toBe(true);
    expect(parse(INVOKE_SCHEMAS["answer:ask"], ["選択"]).success).toBe(false);
    expect(parse(INVOKE_SCHEMAS["answer:ask"], ["選択", 1]).success).toBe(false);
    expect(parse(INVOKE_SCHEMAS["answer:ask"], ["選択", "質問", "余分"]).success).toBe(false);
  });

  it("validates conversation-history:set as a boolean", () => {
    expect(parse(INVOKE_SCHEMAS["conversation-history:set"], [true]).success).toBe(true);
    expect(parse(INVOKE_SCHEMAS["conversation-history:set"], ["yes"]).success).toBe(false);
  });

  it("accepts an absent or string cursor for conversations:list", () => {
    expect(parse(INVOKE_SCHEMAS["conversations:list"], []).success).toBe(true);
    expect(parse(INVOKE_SCHEMAS["conversations:list"], ["cur-1"]).success).toBe(true);
    expect(parse(INVOKE_SCHEMAS["conversations:list"], [42]).success).toBe(false);
    expect(parse(INVOKE_SCHEMAS["conversations:list"], [null]).success).toBe(false);
  });

  it("requires a non-empty string id for conversations:get / delete and history:undo", () => {
    for (const channel of ["conversations:get", "conversations:delete", "history:undo"] as const) {
      expect(parse(INVOKE_SCHEMAS[channel], ["id-1"]).success, channel).toBe(true);
      expect(parse(INVOKE_SCHEMAS[channel], [""]).success, channel).toBe(false);
      expect(parse(INVOKE_SCHEMAS[channel], [42]).success, channel).toBe(false);
      expect(parse(INVOKE_SCHEMAS[channel], []).success, channel).toBe(false);
    }
  });

  it("requires a string for history:paste-analysis and external-link:open", () => {
    expect(parse(INVOKE_SCHEMAS["history:paste-analysis"], ["text"]).success).toBe(true);
    expect(parse(INVOKE_SCHEMAS["history:paste-analysis"], [42]).success).toBe(false);
    expect(parse(INVOKE_SCHEMAS["external-link:open"], ["https://example.com"]).success).toBe(true);
    expect(parse(INVOKE_SCHEMAS["external-link:open"], [42]).success).toBe(false);
  });
});

describe("history:analyze schema", () => {
  const schema = INVOKE_SCHEMAS["history:analyze"];

  it("accepts a full and an empty request", () => {
    expect(
      parse(schema, [
        {
          providers: ["codex", "chatgpt"],
          filePath: "/tmp/export.json",
          fileProvider: "claude",
          mode: "managed",
          sinceMs: 1000,
        },
      ]).success,
    ).toBe(true);
    expect(parse(schema, [{}]).success).toBe(true);
  });

  it("rejects providers and modes outside the domain lists", () => {
    expect(parse(schema, [{ providers: ["not-a-provider"] }]).success).toBe(false);
    expect(parse(schema, [{ fileProvider: "not-a-provider" }]).success).toBe(false);
    expect(parse(schema, [{ mode: "not-a-mode" }]).success).toBe(false);
  });

  it("rejects wrong types and extra keys", () => {
    expect(parse(schema, [{ filePath: 42 }]).success).toBe(false);
    expect(parse(schema, [{ sinceMs: "1000" }]).success).toBe(false);
    expect(parse(schema, [{ providers: "codex" }]).success).toBe(false);
    expect(parse(schema, [{ unexpected: true }]).success).toBe(false);
    expect(parse(schema, ["not-an-object"]).success).toBe(false);
  });

  it("derives the provider allowlist from the domain provider list", () => {
    // domain の HistoryProviderId と一致していること（schemas.ts の satisfies と
    // MissingProvider の型検査で網羅性も強制されている）。
    expect(HISTORY_PROVIDER_IDS).toEqual([
      "codex",
      "chatgpt",
      "claude-code",
      "claude",
      "copilot",
      "cursor",
      "gemini",
      "vscode",
    ]);
  });
});

describe("history:delete-provider schema", () => {
  it("accepts domain providers and rejects anything else", () => {
    for (const provider of HISTORY_PROVIDER_IDS) {
      expect(parse(INVOKE_SCHEMAS["history:delete-provider"], [provider]).success).toBe(true);
    }
    expect(parse(INVOKE_SCHEMAS["history:delete-provider"], ["evil"]).success).toBe(false);
    expect(parse(INVOKE_SCHEMAS["history:delete-provider"], [42]).success).toBe(false);
    expect(parse(INVOKE_SCHEMAS["history:delete-provider"], []).success).toBe(false);
  });
});

describe("history:apply schema", () => {
  const schema = INVOKE_SCHEMAS["history:apply"];

  it("accepts no payload, an empty payload, and excludeConceptIds", () => {
    expect(parse(schema, []).success).toBe(true);
    expect(parse(schema, [{}]).success).toBe(true);
    expect(parse(schema, [{ excludeConceptIds: ["a", "b"] }]).success).toBe(true);
  });

  it("rejects non-string entries and extra keys", () => {
    expect(parse(schema, [{ excludeConceptIds: [1] }]).success).toBe(false);
    expect(parse(schema, [{ excludeConceptIds: "a" }]).success).toBe(false);
    expect(parse(schema, [{ extra: true }]).success).toBe(false);
  });
});

describe("desktopSettingsSchema (settings:save)", () => {
  it("accepts valid settings", () => {
    const result = v.safeParse(desktopSettingsSchema, { ...DEFAULT_SETTINGS, temperature: 0.9 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.output).toEqual({ ...DEFAULT_SETTINGS, temperature: 0.9 });
  });

  it("rejects wrong types", () => {
    const result = v.safeParse(desktopSettingsSchema, {
      ...DEFAULT_SETTINGS,
      restoreClipboard: "yes",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(v.summarize(result.issues)).toContain("restoreClipboard");
  });

  it("rejects a model outside the Managed AI list", () => {
    const result = v.safeParse(desktopSettingsSchema, {
      ...DEFAULT_SETTINGS,
      model: "gemini-3.5-flash",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(v.summarize(result.issues)).toContain("model");
  });

  it("rejects an invalid persona with a message naming the field", () => {
    for (const persona of [42, "あ".repeat(10_000)]) {
      const result = v.safeParse(desktopSettingsSchema, { ...DEFAULT_SETTINGS, persona });
      expect(result.success).toBe(false);
      if (!result.success) expect(v.summarize(result.issues)).toContain("persona");
    }
  });

  it("rejects an unsafe apiBaseUrl with a message naming the field", () => {
    for (const apiBaseUrl of ["http://api.example.com", "not a URL", "ftp://x"]) {
      const result = v.safeParse(desktopSettingsSchema, { ...DEFAULT_SETTINGS, apiBaseUrl });
      expect(result.success).toBe(false);
      if (!result.success) expect(v.summarize(result.issues)).toContain("apiBaseUrl");
    }
  });

  it("accepts https and loopback http apiBaseUrl values", () => {
    for (const apiBaseUrl of [
      "https://api.example.com",
      "http://localhost:8787",
      "http://127.0.0.1:8787",
    ]) {
      const result = v.safeParse(desktopSettingsSchema, { ...DEFAULT_SETTINGS, apiBaseUrl });
      expect(result.success, apiBaseUrl).toBe(true);
    }
  });

  it("rejects out-of-range numeric fields with field-specific messages", () => {
    for (const [field, value] of [
      ["temperature", 2.1],
      ["temperature", -0.1],
      ["temperature", "0.3"],
      ["maxTokens", 0],
      ["maxTokens", MANAGED_AI_MAX_OUTPUT_TOKENS + 1],
      ["maxTokens", 1.5],
    ] as const) {
      const result = v.safeParse(desktopSettingsSchema, { ...DEFAULT_SETTINGS, [field]: value });
      expect(result.success, `${field}=${String(value)}`).toBe(false);
      if (!result.success) {
        expect(v.summarize(result.issues), `${field}=${String(value)}`).toContain(field);
      }
    }
  });

  it("rejects extra keys", () => {
    const result = v.safeParse(desktopSettingsSchema, {
      ...DEFAULT_SETTINGS,
      injected: "extra",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-object input entirely", () => {
    for (const input of [null, 42, "settings", [1]]) {
      expect(v.safeParse(desktopSettingsSchema, input).success).toBe(false);
    }
  });
});
