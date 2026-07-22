import { execFileSync } from "node:child_process";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

function runCli(home: string, args: string[]): string {
  return execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BOOSTIN_HOME: home,
      BOOSTIN_FILEVAULT_STATUS: "On",
    },
    encoding: "utf8",
  });
}

test("fixtures:generate writes synthetic fixtures accepted by both import commands", () => {
  const root = mkdtempSync(join(tmpdir(), "boostin-generated-fixtures-"));
  const output = join(root, "fixtures");
  const home = join(root, "home");
  const stdout = execFileSync(
    "pnpm",
    ["fixtures:generate", "--", "--out", output],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  const posts = join(output, "synthetic-posts.zip");
  const analytics = join(output, "synthetic-analytics.xlsx");

  expect(stdout).toContain("synthetic-posts.zip and synthetic-analytics.xlsx");
  expect(statSync(posts).mode & 0o777).toBe(0o600);
  expect(statSync(analytics).mode & 0o777).toBe(0o600);
  expect(JSON.parse(runCli(home, ["import", "posts", posts, "--json"]))).toMatchObject({
    imported: 1,
    skipped: false,
  });
  expect(
    JSON.parse(
      runCli(home, [
        "import",
        "analytics",
        analytics,
        "--captured-at",
        "2026-01-16T12:00:00.000Z",
        "--json",
      ]),
    ),
  ).toEqual({ imported: 1, skipped: false });
});
