import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

describe("real import safety", () => {
  test("refuses a real import when FileVault is off", () => {
    const root = mkdtempSync(join(tmpdir(), "boostin-test-"));
    const archive = join(root, "linkedin-archive.zip");
    writeFileSync(archive, "not-a-real-zip");

    expect(() =>
      execFileSync(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", "import", "posts", archive],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            BOOSTIN_HOME: join(root, "home"),
            BOOSTIN_FILEVAULT_STATUS: "Off",
          },
          encoding: "utf8",
          stdio: "pipe",
        },
      ),
    ).toThrow(/FileVault must be enabled before importing real data/);
  });
});
