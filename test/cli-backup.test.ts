import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

function run(home: string, args: string[], input?: string): string {
  return execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, BOOSTIN_HOME: home, BOOSTIN_FILEVAULT_STATUS: "On" },
    encoding: "utf8",
    input,
  });
}

describe("portable backups", () => {
  test("restores on a fresh machine without a Keychain dependency", () => {
    const root = mkdtempSync(join(tmpdir(), "boostin-backup-"));
    const originalHome = join(root, "original");
    const restoredHome = join(root, "restored");
    const backup = join(root, "portable.boostin-backup");
    const passphrase = "correct horse battery staple\n";
    run(originalHome, ["init", "--json"]);
    run(originalHome, [
      "draft",
      "new",
      "--title",
      "Private title",
      "--body",
      "Private body",
      "--json",
    ]);

    run(originalHome, ["backup", "create", backup, "--passphrase-stdin", "--json"], passphrase);
    expect(existsSync(backup)).toBe(true);
    expect(statSync(backup).mode & 0o777).toBe(0o600);

    run(restoredHome, ["backup", "restore", backup, "--passphrase-stdin", "--json"], passphrase);
    const drafts = JSON.parse(run(restoredHome, ["draft", "list", "--json"])) as unknown[];
    expect(drafts).toHaveLength(1);
  });

  test("does not create a database when backup authentication fails", () => {
    const root = mkdtempSync(join(tmpdir(), "boostin-backup-auth-"));
    const originalHome = join(root, "original");
    const restoredHome = join(root, "restored");
    const backup = join(root, "portable.boostin-backup");
    run(originalHome, ["init", "--json"]);
    run(
      originalHome,
      ["backup", "create", backup, "--passphrase-stdin", "--json"],
      "correct horse battery staple\n",
    );

    expect(() =>
      run(
        restoredHome,
        ["backup", "restore", backup, "--passphrase-stdin", "--json"],
        "wrong horse battery staple\n",
      ),
    ).toThrow(/authentication failed/);
    expect(existsSync(join(restoredHome, "boostin.db"))).toBe(false);
  });
});
