import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";
import Database from "better-sqlite3";

describe("boostin init", () => {
  test("creates a private local database outside the repository", () => {
    const root = mkdtempSync(join(tmpdir(), "boostin-init-"));
    const home = join(root, "application-support");
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "init", "--json"],
      {
        cwd: process.cwd(),
        env: { ...process.env, BOOSTIN_HOME: home },
        encoding: "utf8",
      },
    );
    const result = JSON.parse(output) as { database: string; created: boolean };

    expect(result).toEqual({ database: join(home, "boostin.db"), created: true });
    expect(statSync(result.database).mode & 0o777).toBe(0o600);
  });

  test("migrates schema v1 transactionally and preserves a private pre-migration backup", () => {
    const root = mkdtempSync(join(tmpdir(), "boostin-migrate-"));
    const home = join(root, "application-support");
    const path = join(home, "boostin.db");
    mkdirSync(home, { recursive: true });
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE posts (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        published_at TEXT NOT NULL,
        body TEXT NOT NULL,
        url TEXT,
        visibility TEXT,
        source_checksum TEXT NOT NULL,
        deleted_at TEXT
      );
      PRAGMA user_version = 1;
    `);
    legacy.close();

    execFileSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "init", "--json"],
      {
        cwd: process.cwd(),
        env: { ...process.env, BOOSTIN_HOME: home },
        encoding: "utf8",
      },
    );

    const migrated = new Database(path, { readonly: true });
    try {
      expect(migrated.pragma("user_version", { simple: true })).toBe(3);
      const columns = migrated.pragma("table_info(posts)") as Array<{
        name: string;
      }>;
      expect(columns.map((column) => column.name)).toContain("source_kind");
      expect(columns.map((column) => column.name)).toContain("source_ref");
    } finally {
      migrated.close();
    }
    const backup = `${path}.pre-v2.bak`;
    expect(existsSync(backup)).toBe(true);
    expect(statSync(backup).mode & 0o777).toBe(0o600);
  });
});
