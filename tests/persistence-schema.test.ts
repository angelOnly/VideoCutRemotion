import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  initializeProjectDatabase,
  PROJECT_DATABASE_TABLES
} from "../packages/edit-application/src/persistence/schema.js";

type SqliteTableRow = { name: string };
type SqliteColumnRow = { name: string; type: string };

test("数据库表结构元数据与实际 DDL 的表、字段和类型保持同步", () => {
  const database = new DatabaseSync(":memory:");
  try {
    initializeProjectDatabase(database);
    const ddlTableNames = (database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as SqliteTableRow[]).map((table) => table.name);

    assert.deepEqual(ddlTableNames, PROJECT_DATABASE_TABLES.map((table) => table.name).sort());

    for (const metadata of PROJECT_DATABASE_TABLES) {
      const ddlColumns = database.prepare(`PRAGMA table_info(${metadata.name})`).all() as SqliteColumnRow[];
      assert.deepEqual(
        ddlColumns.map((column) => column.name).sort(),
        metadata.columns.map((column) => column.name).sort(),
        `${metadata.name} 的字段目录必须与 DDL 一致`
      );
      for (const column of metadata.columns) {
        const ddlColumn = ddlColumns.find((candidate) => candidate.name === column.name);
        assert.equal(
          ddlColumn?.type.toUpperCase(),
          column.sqlType,
          `${metadata.name}.${column.name} 的字段类型必须与 DDL 一致`
        );
      }
    }
  } finally {
    database.close();
  }
});
