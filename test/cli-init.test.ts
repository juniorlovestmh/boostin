import { execFileSync } from "node:child_process";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

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
});
