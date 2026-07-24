import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { createZip } from "./helpers/archive.js";

function run(home: string, args: string[]): string {
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", ...args],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOOSTIN_HOME: home,
        BOOSTIN_FILEVAULT_STATUS: "On",
      },
      encoding: "utf8",
    },
  );
}

describe("explicit inbox", () => {
  test("imports recognized files, archives them locally, and rejects unknown files", async () => {
    const root = mkdtempSync(join(tmpdir(), "boostin-inbox-"));
    const home = join(root, "home");
    const inbox = join(home, "inbox");
    mkdirSync(inbox, { recursive: true });
    await createZip(join(inbox, "linkedin.zip"), {
      "Profile.csv":
        "First Name,Last Name,Public Profile URL\nSynthetic,User,https://social.example/profiles/synthetic-user\n",
      "Shares.csv":
        "Date,ShareLink,ShareCommentary,Visibility\n2026-07-20 10:00:00,https://social.example/posts/1,Inbox post,PUBLIC\n",
    });

    const result = JSON.parse(
      run(home, ["inbox", "process", "--json"]),
    ) as { processed: number; posts: number; analytics: number };
    expect(result).toEqual({ processed: 1, posts: 1, analytics: 0 });
    expect(readdirSync(inbox)).toEqual(["processed"]);
    expect(readdirSync(join(inbox, "processed"))).toHaveLength(1);

    writeFileSync(join(inbox, "unknown.txt"), "not an import", { mode: 0o600 });
    expect(() => run(home, ["inbox", "process", "--json"])).toThrow(
      /Unsupported inbox file/,
    );
    expect(existsSync(join(inbox, "unknown.txt"))).toBe(true);
  });
});
