import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";
import Database from "better-sqlite3";

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

describe("post archive import", () => {
  test("imports the user's own posts once and binds the profile identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "boostin-posts-"));
    const home = join(root, "home");
    const archive = join(root, "linkedin.zip");
    await createZip(archive, {
      "Profile.csv":
        "First Name,Last Name,Public Profile URL\nSynthetic,User,https://social.example/profiles/synthetic-user\n",
      "Shares.csv":
        "Date,ShareLink,ShareCommentary,Visibility\n2026-07-20 10:00:00,https://social.example/posts/1,AI agents need approval boundaries.,PUBLIC\n",
    });

    const first = JSON.parse(
      run(home, ["import", "posts", archive, "--json"]),
    ) as { imported: number; skipped: boolean; profileId: string };
    const second = JSON.parse(
      run(home, ["import", "posts", archive, "--json"]),
    ) as { imported: number; skipped: boolean; profileId: string };

    expect(first).toEqual({
      imported: 1,
      skipped: false,
      profileId: "https://social.example/profiles/synthetic-user",
    });
    expect(second).toEqual({
      imported: 0,
      skipped: true,
      profileId: "https://social.example/profiles/synthetic-user",
    });
  });

  test("rejects a different profile and tombstones posts absent from a newer archive", async () => {
    const root = mkdtempSync(join(tmpdir(), "boostin-profile-boundary-"));
    const home = join(root, "home");
    const firstArchive = join(root, "first.zip");
    const secondArchive = join(root, "second.zip");
    const foreignArchive = join(root, "foreign.zip");
    const profile = "https://social.example/profiles/synthetic-user";
    await createZip(firstArchive, {
      "Profile.csv": `First Name,Last Name,Public Profile URL\nSynthetic,User,${profile}\n`,
      "Shares.csv":
        "Date,ShareLink,ShareCommentary,Visibility\n2026-07-20 10:00:00,https://social.example/posts/1,First post,PUBLIC\n2026-07-21 10:00:00,https://social.example/posts/2,Second post,PUBLIC\n",
    });
    await createZip(secondArchive, {
      "Profile.csv": `First Name,Last Name,Public Profile URL\nSynthetic,User,${profile}\n`,
      "Shares.csv":
        "Date,ShareLink,ShareCommentary,Visibility\n2026-07-21 10:00:00,https://social.example/posts/2,Second post,PUBLIC\n",
    });
    await createZip(foreignArchive, {
      "Profile.csv":
        "First Name,Last Name,Public Profile URL\nOther,User,https://social.example/profiles/other-user\n",
      "Shares.csv":
        "Date,ShareLink,ShareCommentary,Visibility\n2026-07-22 10:00:00,https://social.example/posts/3,Foreign post,PUBLIC\n",
    });

    run(home, ["import", "posts", firstArchive, "--json"]);
    run(home, ["import", "posts", secondArchive, "--json"]);
    expect(() => run(home, ["import", "posts", foreignArchive, "--json"])).toThrow(
      /different profile/,
    );

    const database = new Database(join(home, "boostin.db"), { readonly: true });
    try {
      const posts = database
        .prepare("SELECT url, deleted_at FROM posts ORDER BY url")
        .all() as { url: string; deleted_at: string | null }[];
      expect(posts[0]?.deleted_at).not.toBeNull();
      expect(posts[1]?.deleted_at).toBeNull();
      expect(database.pragma("user_version", { simple: true })).toBe(1);
    } finally {
      database.close();
    }
  });
});
