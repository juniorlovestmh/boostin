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
    env: { ...process.env, BOOSTIN_HOME: home, BOOSTIN_FILEVAULT_STATUS: "Off" },
    encoding: "utf8",
  });
}

describe("doctor", () => {
  test("reports readiness and emits a value-free archive fingerprint", async () => {
    const root = mkdtempSync(join(tmpdir(), "boostin-doctor-"));
    const home = join(root, "home");
    const archive = join(root, "private.zip");
    await createZip(archive, {
      "Profile.csv":
        "First Name,Last Name,Public Profile URL\nSecret,Person,https://example.invalid/private\n",
      "Shares.csv":
        "Date,ShareLink,ShareCommentary,Visibility\n2026-07-20,https://example.invalid/post,Highly private prose,PUBLIC\n",
    });

    const doctor = JSON.parse(run(home, ["doctor", "--json"])) as {
      fileVault: string;
      readyForRealData: boolean;
    };
    const fingerprint = run(home, ["doctor", "--fingerprint", archive, "--json"]);

    expect(doctor).toMatchObject({ fileVault: "Off", readyForRealData: false });
    expect(fingerprint).toContain("ShareCommentary");
    expect(fingerprint).not.toContain("Secret");
    expect(fingerprint).not.toContain("Highly private prose");
    expect(fingerprint).not.toContain("example.invalid");
  });

  test("fingerprints an analytics workbook without exposing cell values", async () => {
    const root = mkdtempSync(join(tmpdir(), "boostin-doctor-xlsx-"));
    const home = join(root, "home");
    const workbook = join(root, "analytics.xlsx");
    await createXlsx(workbook, [
      ["Post URL", "Impressions"],
      ["https://social.example/posts/private", "9876"],
    ]);

    const fingerprint = run(home, ["doctor", "--fingerprint", workbook, "--json"]);
    expect(fingerprint).toContain("first-party-analytics-workbook");
    expect(fingerprint).toContain("Impressions");
    expect(fingerprint).not.toContain("posts/private");
    expect(fingerprint).not.toContain("9876");
  });

  test("never emits arbitrary cells when a workbook is transposed or malformed", async () => {
    const root = mkdtempSync(join(tmpdir(), "boostin-doctor-transposed-"));
    const home = join(root, "home");
    const workbook = join(root, "legacy-analytics.xlsx");
    await createXlsx(workbook, [
      ["Post URL", "https://social.example/posts/private"],
      ["Impressions", "9876"],
    ]);

    const fingerprint = run(home, ["doctor", "--fingerprint", workbook, "--json"]);
    expect(fingerprint).toContain("Post URL");
    expect(fingerprint).not.toContain("posts/private");
    expect(fingerprint).not.toContain("9876");
  });

  test("never emits arbitrary CSV header cells", async () => {
    const root = mkdtempSync(join(tmpdir(), "boostin-doctor-csv-header-"));
    const home = join(root, "home");
    const archive = join(root, "malformed.zip");
    await createZip(archive, {
      "Profile.csv":
        "First Name,https://social.example/profiles/private\nSynthetic,private value\n",
      "Shares.csv":
        "Date,ShareCommentary,private customer name\n2026-07-20,Synthetic post,private value\n",
    });

    const fingerprint = run(home, ["doctor", "--fingerprint", archive, "--json"]);
    expect(fingerprint).toContain("First Name");
    expect(fingerprint).toContain("ShareCommentary");
    expect(fingerprint).not.toContain("profiles/private");
    expect(fingerprint).not.toContain("private customer name");
  });

  test("recognizes fields in a transposed or legacy CSV archive without exposing values", async () => {
    const root = mkdtempSync(join(tmpdir(), "boostin-doctor-csv-transposed-"));
    const home = join(root, "home");
    const archive = join(root, "legacy.zip");
    await createZip(archive, {
      "Profile.csv":
        "Export Version,2026,Q3\nFirst Name,Last Name,Public Profile URL\nSecret,Person,https://example.invalid/private\n",
      "Shares.csv":
        "Export Version,2026,Q3,Legacy\nDate,ShareLink,ShareCommentary,Visibility\n2026-07-20,https://example.invalid/post,Highly private prose,PUBLIC\n",
    });

    const fingerprint = run(home, ["doctor", "--fingerprint", archive, "--json"]);

    expect(fingerprint).toContain("First Name");
    expect(fingerprint).toContain("ShareCommentary");
    expect(fingerprint).not.toContain("Secret");
    expect(fingerprint).not.toContain("Highly private prose");
    expect(fingerprint).not.toContain("example.invalid");
  });
});
