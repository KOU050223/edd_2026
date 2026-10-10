import { describe, expect, test } from "vitest";
import { extractSchemaNames, MAX_SCHEMA_NAMES_PER_FILE } from "./schema.js";

describe("extractSchemaNames", () => {
  test("Rails の schema.rb", () => {
    const text =
      'create_table "orders", force: :cascade do |t|\nend\ncreate_table "order_items" do |t|\nend';
    expect(extractSchemaNames("db/schema.rb", text)).toEqual(["orders", "order_items"]);
  });

  test("Prisma のモデル", () => {
    expect(
      extractSchemaNames("prisma/schema.prisma", "model Order {\n}\nmodel Customer {\n}\n"),
    ).toEqual(["Order", "Customer"]);
  });

  test("SQL の CREATE TABLE（IF NOT EXISTS・引用符つき）", () => {
    const sql =
      'CREATE TABLE IF NOT EXISTS "public.orders" (id int);\ncreate table `items` (id int);';
    expect(extractSchemaNames("db/schema.sql", sql)).toEqual(["public.orders", "items"]);
  });

  test("proto と OpenAPI（YAML）", () => {
    expect(extractSchemaNames("api/order.proto", "message Order {}\nmessage Item {}")).toEqual([
      "Order",
      "Item",
    ]);
    const yaml =
      "components:\n  schemas:\n    Order:\n      type: object\n    Customer:\n      type: object\n";
    expect(extractSchemaNames("openapi.yaml", yaml)).toEqual(["Order", "Customer"]);
  });

  test("重複は 1 つにし、1 ファイルの上限で切る。知らない種類は空", () => {
    const many = Array.from({ length: 80 }, (_, i) => `message M${String(i)} {}`).join("\n");
    expect(extractSchemaNames("a.proto", many)).toHaveLength(MAX_SCHEMA_NAMES_PER_FILE);
    expect(extractSchemaNames("a.proto", "message A {}\nmessage A {}")).toEqual(["A"]);
    expect(extractSchemaNames("README.md", 'create_table "x"')).toEqual([]);
  });
});
