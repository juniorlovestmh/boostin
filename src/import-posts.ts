import { createHash } from "node:crypto";

import { parse } from "csv-parse/sync";

import { readAllowedArchive } from "./archive.js";
import { openDatabase } from "./database.js";

interface ProfileRow {
  "First Name": string;
  "Last Name": string;
  "Public Profile URL": string;
}

interface ShareRow {
  Date: string;
  ShareLink: string;
  ShareCommentary: string;
  Visibility: string;
}

export interface ImportPostsResult {
  imported: number;
  skipped: boolean;
  profileId: string;
}

function parseCsv<T extends object>(
  buffer: Buffer,
  expectedColumns: readonly string[],
  label: string,
): T[] {
  let columns: string[] = [];
  const rows = parse(buffer, {
    bom: true,
    columns: (header: string[]) => {
      columns = header;
      return header;
    },
    skip_empty_lines: true,
    trim: true,
  }) as T[];
  const missing = expectedColumns.filter((column) => !columns.includes(column));
  const unexpected = columns.filter((column) => !expectedColumns.includes(column));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `${label} schema mismatch; missing=[${missing.join(",")}] unexpected=[${unexpected.join(",")}]`,
    );
  }
  return rows;
}

function postId(profileId: string, row: ShareRow): string {
  return createHash("sha256")
    .update([profileId, row.Date, row.ShareLink, row.ShareCommentary].join("\0"))
    .digest("hex");
}

export async function importPosts(path: string): Promise<ImportPostsResult> {
  const archive = await readAllowedArchive(
    path,
    new Set(["Profile.csv", "Shares.csv"]),
  );
  const profileFile = archive.entries.get("Profile.csv");
  const sharesFile = archive.entries.get("Shares.csv");
  if (!profileFile || !sharesFile) {
    throw new Error("Archive must contain Profile.csv and Shares.csv");
  }

  const profiles = parseCsv<ProfileRow>(
    profileFile,
    ["First Name", "Last Name", "Public Profile URL"],
    "Profile.csv",
  );
  if (profiles.length !== 1) throw new Error("Profile.csv must contain one profile");
  const profileId = profiles[0]?.["Public Profile URL"];
  if (!profileId) throw new Error("Profile.csv is missing a public profile URL");
  const shares = parseCsv<ShareRow>(
    sharesFile,
    ["Date", "ShareLink", "ShareCommentary", "Visibility"],
    "Shares.csv",
  );

  const { database } = openDatabase();
  try {
    const existingImport = database
      .prepare("SELECT 1 FROM imports WHERE checksum = ?")
      .get(archive.checksum);
    const bound = database
      .prepare("SELECT value FROM metadata WHERE key = 'profile_id'")
      .get() as { value: string } | undefined;
    if (bound && bound.value !== profileId) {
      throw new Error(`Archive belongs to a different profile: ${profileId}`);
    }
    if (existingImport) return { imported: 0, skipped: true, profileId };

    const insert = database.prepare(`
      INSERT INTO posts
        (id, profile_id, published_at, body, url, visibility, source_checksum)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        body = excluded.body,
        url = excluded.url,
        visibility = excluded.visibility,
        source_checksum = excluded.source_checksum,
        deleted_at = NULL
    `);
    const commit = database.transaction(() => {
      database
        .prepare("INSERT OR IGNORE INTO metadata (key, value) VALUES ('profile_id', ?)")
        .run(profileId);
      database
        .prepare("UPDATE posts SET deleted_at = ? WHERE profile_id = ? AND deleted_at IS NULL")
        .run(new Date().toISOString(), profileId);
      for (const row of shares) {
        if (!row.Date || !row.ShareCommentary) {
          throw new Error("Shares.csv contains a row without Date or ShareCommentary");
        }
        insert.run(
          postId(profileId, row),
          profileId,
          row.Date,
          row.ShareCommentary,
          row.ShareLink || null,
          row.Visibility || null,
          archive.checksum,
        );
      }
      database
        .prepare(
          "INSERT INTO imports (kind, checksum, fingerprint, imported_at) VALUES ('posts', ?, ?, ?)",
        )
        .run(archive.checksum, archive.fingerprint, new Date().toISOString());
    });
    commit();
    return { imported: shares.length, skipped: false, profileId };
  } finally {
    database.close();
  }
}
