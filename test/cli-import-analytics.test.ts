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
  });
}

describe("analytics import", () => {
  test.each([
    `<?xml version="1.0"?><!DOCTYPE workbook [<!ENTITY synthetic "value">]>`,
    `<?xml version="1.0"?><!ENTITY synthetic "value">`,
  ])("rejects prohibited workbook XML declarations", async (xmlPrefix) => {
    const root = mkdtempSync(join(tmpdir(), "boostin-hostile-xml-"));
    const home = join(root, "home");
    const analytics = join(root, "hostile.xlsx");
    await createXlsx(analytics, [["Post URL"]], xmlPrefix);

    expect(() =>
      run(home, [
        "import",
        "analytics",
        analytics,
        "--captured-at",
        "2026-07-21T12:00:00.000Z",
        "--json",
      ]),
    ).toThrow(/XLSX contains prohibited XML declarations/);
  });

  test("adds a metric snapshot to the matching post", async () => {
    const root = mkdtempSync(join(tmpdir(), "boostin-analytics-"));
    const home = join(root, "home");
    const archive = join(root, "posts.zip");
    const analytics = join(root, "analytics.xlsx");
    const url = "https://social.example/posts/1";
    await createZip(archive, {
      "Profile.csv":
        "First Name,Last Name,Public Profile URL\nSynthetic,User,https://social.example/profiles/synthetic-user\n",
      "Shares.csv":
        `Date,ShareLink,ShareCommentary,Visibility\n2026-07-20 10:00:00,${url},AI agents need approval boundaries.,PUBLIC\n`,
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

    const result = JSON.parse(
      run(home, [
        "import",
        "analytics",
        analytics,
        "--captured-at",
        "2026-07-21T12:00:00.000Z",
        "--json",
      ]),
    ) as { imported: number; skipped: boolean };

    expect(result).toEqual({ imported: 1, skipped: false });
  });

  test("rejects a renamed column without partially recording the import", async () => {
    const root = mkdtempSync(join(tmpdir(), "boostin-analytics-schema-"));
    const home = join(root, "home");
    const archive = join(root, "posts.zip");
    const invalid = join(root, "invalid.xlsx");
    const valid = join(root, "valid.xlsx");
    const url = "https://social.example/posts/1";
    await createZip(archive, {
      "Profile.csv":
        "First Name,Last Name,Public Profile URL\nSynthetic,User,https://social.example/profiles/synthetic-user\n",
      "Shares.csv":
        `Date,ShareLink,ShareCommentary,Visibility\n2026-07-20 10:00:00,${url},Synthetic post,PUBLIC\n`,
    });
    const header = [
      "Post URL",
      "Impressions",
      "Members reached",
      "Reactions",
      "Comments",
      "Reposts",
      "Saves",
      "Sends",
      "Out-of-network %",
    ];
    await createXlsx(invalid, [
      header.map((column) => (column === "Impressions" ? "Views" : column)),
      [url, "344", "210", "4", "3", "0", "2", "0", "27"],
    ]);
    await createXlsx(valid, [
      header,
      [url, "344", "210", "4", "3", "0", "2", "0", "27"],
    ]);
    run(home, ["import", "posts", archive, "--json"]);

    expect(() =>
      run(home, [
        "import",
        "analytics",
        invalid,
        "--captured-at",
        "2026-07-21T12:00:00.000Z",
        "--json",
      ]),
    ).toThrow(/schema mismatch/);
    expect(
      JSON.parse(
        run(home, [
          "import",
          "analytics",
          valid,
          "--captured-at",
          "2026-07-21T12:00:00.000Z",
          "--json",
        ]),
      ),
    ).toEqual({ imported: 1, skipped: false });
  });
});
