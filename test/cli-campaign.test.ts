import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

function run(
  home: string,
  args: string[],
  env: Record<string, string> = {},
): string {
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", ...args],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOOSTIN_HOME: home,
        BOOSTIN_FILEVAULT_STATUS: "On",
        ...env,
      },
      encoding: "utf8",
    },
  );
}

describe("campaign workflow", () => {
  test("schedules checkpoints, exposes overdue work, completes it, and installs reminders", () => {
    const root = mkdtempSync(join(tmpdir(), "boostin-campaign-"));
    const home = join(root, "home");
    const launchAgents = join(root, "LaunchAgents");
    const campaign = JSON.parse(
      run(home, [
        "campaign",
        "start",
        "--slug",
        "career-graph",
        "--article-url",
        "https://appheat.co/posts/career-graph/",
        "--post-url",
        "https://social.example/posts/career-graph",
        "--published-at",
        "2026-07-23T12:00:00-03:00",
        "--json",
      ]),
    ) as { slug: string; checkpoints: Array<{ name: string; dueAt: string }> };
    expect(campaign.slug).toBe("career-graph");
    expect(campaign.checkpoints.map((checkpoint) => checkpoint.name)).toEqual([
      "24h",
      "72h",
      "7d",
      "30d",
    ]);
    expect(campaign.checkpoints[0]?.dueAt).toBe("2026-07-24T15:00:00.000Z");

    const due = JSON.parse(
      run(home, ["due", "--json"], {
        BOOSTIN_NOW: "2026-07-24T16:00:00.000Z",
      }),
    ) as Array<{ campaign: string; checkpoint: string; overdue: boolean }>;
    expect(due).toEqual([
      expect.objectContaining({
        campaign: "career-graph",
        checkpoint: "24h",
        overdue: true,
      }),
    ]);

    run(home, [
      "checkpoint",
      "complete",
      "--campaign",
      "career-graph",
      "--name",
      "24h",
      "--captured-at",
      "2026-07-24T16:00:00.000Z",
      "--json",
    ]);
    expect(
      JSON.parse(
        run(home, ["due", "--json"], {
          BOOSTIN_NOW: "2026-07-24T16:00:00.000Z",
        }),
      ),
    ).toEqual([]);

    const installed = JSON.parse(
      run(
        home,
        ["reminders", "install", "--json"],
        {
          BOOSTIN_LAUNCH_AGENTS_DIR: launchAgents,
          BOOSTIN_SKIP_LAUNCHCTL: "1",
          BOOSTIN_CLI_PATH: "/opt/local/bin/boostin",
        },
      ),
    ) as { plist: string; installed: boolean };
    expect(installed.installed).toBe(true);
    expect(existsSync(installed.plist)).toBe(true);
    expect(readFileSync(installed.plist, "utf8")).toContain(
      "/opt/local/bin/boostin",
    );

    const report = join(root, "campaign.md");
    run(home, [
      "report",
      "campaign",
      "--slug",
      "career-graph",
      "--private",
      "--out",
      report,
    ]);
    expect(readFileSync(report, "utf8")).toContain("career-graph");
    expect(statSync(report).mode & 0o777).toBe(0o600);
  });

  test("uses elapsed checkpoints across a daylight-saving transition", () => {
    const root = mkdtempSync(join(tmpdir(), "boostin-campaign-dst-"));
    const home = join(root, "home");
    const campaign = JSON.parse(
      run(home, [
        "campaign",
        "start",
        "--slug",
        "dst-check",
        "--article-url",
        "https://appheat.co/posts/dst-check/",
        "--post-url",
        "https://social.example/posts/dst-check",
        "--published-at",
        "2026-03-07T12:00:00-05:00",
        "--timezone",
        "America/New_York",
        "--json",
      ]),
    ) as { checkpoints: Array<{ name: string; dueAt: string }> };

    expect(campaign.checkpoints[0]).toEqual({
      name: "24h",
      dueAt: "2026-03-08T17:00:00.000Z",
    });
  });
});
