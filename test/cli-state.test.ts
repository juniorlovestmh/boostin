import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

function run(home: string, args: string[]): string {
  return execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, BOOSTIN_HOME: home, BOOSTIN_FILEVAULT_STATUS: "On" },
    encoding: "utf8",
  });
}

describe("private planning state", () => {
  test("records profile snapshots, drafts, and self-reported outcomes", () => {
    const root = mkdtempSync(join(tmpdir(), "boostin-state-"));
    const home = join(root, "home");
    const snapshot = JSON.parse(
      run(home, [
        "snapshot",
        "profile",
        "--captured-at",
        "2026-07-21T12:00:00.000Z",
        "--followers",
        "3099",
        "--profile-views",
        "99",
        "--search-appearances",
        "34",
        "--json",
      ]),
    ) as { recorded: boolean };
    const draft = JSON.parse(
      run(home, [
        "draft",
        "new",
        "--title",
        "CRM approval boundaries",
        "--body",
        "A private working draft",
        "--pillar",
        "applied-ai-revops",
        "--audience",
        "revops-leaders",
        "--json",
      ]),
    ) as { id: string; status: string };
    const outcome = JSON.parse(
      run(home, [
        "outcome",
        "add",
        "--occurred-at",
        "2026-07-21",
        "--type",
        "recruiter",
        "--count",
        "1",
        "--note",
        "Private note",
        "--json",
      ]),
    ) as { id: string; count: number };

    expect(snapshot.recorded).toBe(true);
    expect(draft.status).toBe("drafting");
    expect(draft.id).toHaveLength(36);
    expect(outcome.count).toBe(1);
  });
});
