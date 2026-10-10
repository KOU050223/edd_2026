/**
 * データの形（スキーマ）の名前を、AI を使わずに機械で読む（#249 の ⑧）。
 *
 * 書式が決まっているので正規表現で足りる。マイグレーションは読まない（変更の履歴で、消したテーブルや
 * 旧名も残る）。今の形をまとめたファイル（`schema.rb`・`schema.prisma`・`schema.sql`・OpenAPI・proto）だけ。
 * 読んだ名前は候補とのつき合わせと、文書が薄いリポジトリの材料に使う。AI へは「機械で抽出した名前」として
 * 渡す（ファイルそのものは渡さない）。
 */

/** 1 ファイルから取る名前の上限。 */
export const MAX_SCHEMA_NAMES_PER_FILE = 30;

/** パスの種類に合わせて、テーブル・モデル・スキーマ・メッセージの名前を重複なく返す。読めない種類は空。 */
export function extractSchemaNames(path: string, text: string): string[] {
  const names = new Set<string>();
  const lower = path.toLowerCase();
  const add = (name: string | undefined) => {
    if (name !== undefined && name !== "") names.add(name);
  };
  if (/schema\.rb$/.test(lower)) {
    for (const m of text.matchAll(/create_table\s+"([^"]+)"/g)) add(m[1]);
  } else if (/\.prisma$/.test(lower)) {
    for (const m of text.matchAll(/^model\s+(\w+)/gm)) add(m[1]);
  } else if (/\.sql$/.test(lower)) {
    for (const m of text.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?[`"']?([\w.]+)/gi)) {
      add(m[1]);
    }
  } else if (/openapi\.(ya?ml|json)$/.test(lower)) {
    // components.schemas の直下の名前（YAML の 4〜6 スペースの字下げ）。
    for (const m of text.matchAll(/^\s{4,6}([A-Z]\w+):\s*$/gm)) add(m[1]);
    for (const m of text.matchAll(/"([A-Z]\w+)"\s*:\s*\{\s*\n?\s*"type"/g)) add(m[1]);
  } else if (/\.proto$/.test(lower)) {
    for (const m of text.matchAll(/^message\s+(\w+)/gm)) add(m[1]);
  }
  return [...names].slice(0, MAX_SCHEMA_NAMES_PER_FILE);
}
