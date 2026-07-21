import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { createZip } from "./helpers/archive.js";
import { createXlsx } from "./helpers/xlsx.js";

function run(home: string, args: string[]): string {
  return execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BOOSTIN_HOME: home,
      BOOSTIN_FILEVAULT_STATUS: "On",
    },
    encoding: "utf8",
    stdio: "pipe",
  });
}

describe("weekly reports", () => {
  test("keeps post text private and requires confirmation for public output", async () => {
    const root = mkdtempSync(join(tmpdir(), "boostin-report-"));
    const home = join(root, "home");
    const archive = join(root, "posts.zip");
    const analytics = join(root, "analytics.xlsx");
    const url = "https://social.example/posts/1";
    const privateText = "Client Alpha needs an approval boundary.";
    await createZip(archive, {
      "Profile.csv":
        "First Name,Last Name,Public Profile URL\nSynthetic,User,https://social.example/profiles/synthetic-user\n",
      "Shares.csv":
        `Date,ShareLink,ShareCommentary,Visibility\n2026-07-20 10:00:00,${url},${privateText},PUBLIC\n`,
    });
    await createXlsx(analytics, [
      [
        "Post URL",
        "Impressions",
        "Members reached",
        "Reactions",
        "Comments",
        "Reposts",
        "Saves",
        "Sends",
        "Out-of-network %",
      ],
      [url, "344", "210", "4", "3", "0", "2", "0", "27"],
    ]);
    run(home, ["import", "posts", archive, "--json"]);
    run(home, [
      "import",
      "analytics",
      analytics,
      "--captured-at",
      "2026-07-21T12:00:00.000Z",
      "--json",
    ]);

    const privateReport = run(home, [
      "report",
      "weekly",
      "--private",
      "--week",
      "2026-07-20",
    ]);
    expect(privateReport).toContain(privateText);
    expect(privateReport).toContain("Impressions: 344");

    expect(() =>
      run(home, ["report", "weekly", "--public", "--week", "2026-07-20"]),
    ).toThrow(/Public report generation requires --confirm-public/);

    const publicReport = run(home, [
      "report",
      "weekly",
      "--public",
      "--confirm-public",
      "--week",
      "2026-07-20",
    ]);
    expect(publicReport).toContain("Impressions: 344");
    expect(publicReport).not.toContain(privateText);
    expect(publicReport).not.toContain("Client Alpha");
    expect(
      run(home, [
        "report",
        "weekly",
        "--public",
        "--confirm-public",
        "--week",
        "2026-07-20",
      ]),
    ).toBe(publicReport);
  });
});
