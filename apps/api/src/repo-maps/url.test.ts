import { describe, expect, test } from "vitest";
import { issueLink, parseRepoUrl, permalink, repoUrl } from "./url.js";

describe("parseRepoUrl", () => {
  test.each([
    ["github.com/owner/repo", { owner: "owner", name: "repo" }],
    ["https://github.com/owner/repo", { owner: "owner", name: "repo" }],
    ["http://www.github.com/owner/repo/", { owner: "owner", name: "repo" }],
    ["  github.com/Rails-Event/ecommerce.v2  ", { owner: "Rails-Event", name: "ecommerce.v2" }],
  ])("%s を受ける", (input, expected) => {
    expect(parseRepoUrl(input)).toEqual(expected);
  });

  test.each([
    "",
    "owner/repo",
    "github.com/owner",
    "github.com/owner/repo/tree/main",
    "github.com/owner/repo?tab=readme",
    "github.com/owner/repo.git",
    "github.com/owner/..",
    "gitlab.com/owner/repo",
    "https://github.com.evil.example/owner/repo",
    "github.com/-owner/repo",
  ])("%j は受けない", (input) => {
    expect(parseRepoUrl(input)).toBeNull();
  });
});

describe("リンク", () => {
  const ref = { owner: "o", name: "r" };
  const sha = "a".repeat(40);

  test("根拠のリンクは commit SHA で固定し、パスを符号化する", () => {
    expect(permalink(ref, sha, "docs/用語 集.md")).toBe(
      `https://github.com/o/r/blob/${sha}/docs/${encodeURIComponent("用語 集.md")}`,
    );
  });

  test("表記と Issue のリンク", () => {
    expect(repoUrl(ref)).toBe("github.com/o/r");
    expect(issueLink(ref, 12)).toBe("https://github.com/o/r/issues/12");
  });
});
