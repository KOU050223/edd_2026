/**
 * Vite（vitest）の `?raw` 読み込み。ファイルの中身を文字列として受け取る。
 *
 * テストだけが使う。API の tsconfig は Workers の型だけを載せており `node:fs` が無いため、
 * マイグレーションの DDL を検査するテスト（`checks/migration.test.ts`）はこれで読む。
 */
declare module "*?raw" {
  const content: string;
  export default content;
}
