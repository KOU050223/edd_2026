/**
 * リポジトリの指定（#249）。
 *
 * 受け付けるのは `github.com/owner/repo` の形だけ（`https://` と `www.`、末尾の `/` は許す）。
 * ブランチ・サブパス・`.git`・クエリは受けない。取得するのは常に既定のブランチなので、
 * 別の場所を指す URL を黙って既定のブランチへ読み替えない。
 */

export type RepoRef = { owner: string; name: string };

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const URL_FORM = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/?#\s]+)\/([^/?#\s]+)\/?$/i;

/** 形に合わなければ null。 */
export function parseRepoUrl(input: string): RepoRef | null {
  const match = URL_FORM.exec(input.trim());
  if (match === null) return null;
  const [, owner, name] = match;
  if (owner === undefined || name === undefined) return null;
  if (!OWNER.test(owner) || !NAME.test(name)) return null;
  if (name === "." || name === ".." || name.endsWith(".git")) return null;
  return { owner, name };
}

/** 画面と保存に使う表記（`github.com/owner/repo`）。 */
export function repoUrl(ref: RepoRef): string {
  return `github.com/${ref.owner}/${ref.name}`;
}

/** 根拠のリンク。取得した時点の commit SHA で固定する（パーマリンク）。 */
export function permalink(ref: RepoRef, commitSha: string, path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${ref.owner}/${ref.name}/blob/${commitSha}/${encoded}`;
}

/** Issue のリンク。Issue 番号は変わらないので SHA で固定しない。 */
export function issueLink(ref: RepoRef, number: number): string {
  return `https://github.com/${ref.owner}/${ref.name}/issues/${number}`;
}
