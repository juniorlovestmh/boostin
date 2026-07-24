import { createHash } from "node:crypto";

import { parse } from "csv-parse/sync";

import { readSelectedArchive } from "./archive.js";
import { openDatabase } from "./database.js";

const LEGACY_PROFILE_COLUMNS = [
  "First Name",
  "Last Name",
  "Public Profile URL",
] as const;
const CURRENT_PROFILE_COLUMNS = [
  "First Name",
  "Last Name",
  "Maiden Name",
  "Address",
  "Birth Date",
  "Headline",
  "Summary",
  "Industry",
  "Zip Code",
  "Geo Location",
  "Twitter Handles",
  "Websites",
  "Instant Messengers",
] as const;
const LEGACY_SHARE_COLUMNS = [
  "Date",
  "ShareLink",
  "ShareCommentary",
  "Visibility",
] as const;
const CURRENT_SHARE_COLUMNS = [
  "Date",
  "ShareLink",
  "ShareCommentary",
  "SharedUrl",
  "MediaUrl",
  "Visibility",
] as const;
const SHARES_FILE = /^Shares(?:_([0-9]+))?\.csv$/;

interface ProfileRow {
  "First Name": string;
  "Last Name": string;
  "Public Profile URL"?: string;
}

interface ShareRow {
  Date: string;
  ShareLink: string;
  ShareCommentary: string;
  SharedUrl?: string;
  MediaUrl?: string;
  Visibility: string;
}

export interface ImportPostsResult {
  imported: number;
  skipped: boolean;
  profileId: string;
  adapter: "linkedin-legacy" | "linkedin-2026";
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
    .update(
      [
        profileId,
        row.Date,
        row.ShareLink,
        row.ShareCommentary,
        row.SharedUrl ?? "",
        row.MediaUrl ?? "",
      ].join("\0"),
    )
    .digest("hex");
}

export async function importPosts(path: string): Promise<ImportPostsResult> {
  const archive = await readSelectedArchive(
    path,
    (name) => name === "Profile.csv" || SHARES_FILE.test(name),
  );
  const profileFile = archive.entries.get("Profile.csv");
  const shareFiles = [...archive.entries.entries()].filter(([name]) =>
    SHARES_FILE.test(name),
  );
  if (!profileFile) throw new Error("Archive must contain Profile.csv");
  if (shareFiles.length !== 1) {
    throw new Error("Archive must contain exactly one recognized Shares file");
  }
  const [sharesName, sharesFile] = shareFiles[0]!;
  const sharesMatch = SHARES_FILE.exec(sharesName)!;
  const memberId = sharesMatch[1];
  const adapter = memberId ? "linkedin-2026" : "linkedin-legacy";
  const profiles = parseCsv<ProfileRow>(
    profileFile,
    adapter === "linkedin-2026"
      ? CURRENT_PROFILE_COLUMNS
      : LEGACY_PROFILE_COLUMNS,
    "Profile.csv",
  );
  if (profiles.length !== 1) throw new Error("Profile.csv must contain one profile");
  const profileId =
    adapter === "linkedin-2026"
      ? `linkedin-member:${memberId}`
      : profiles[0]?.["Public Profile URL"];
  if (!profileId) throw new Error("Profile.csv is missing a public profile URL");
  const shares = parseCsv<ShareRow>(
    sharesFile,
    adapter === "linkedin-2026"
      ? CURRENT_SHARE_COLUMNS
      : LEGACY_SHARE_COLUMNS,
    sharesName,
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
    if (existingImport) {
      return { imported: 0, skipped: true, profileId, adapter };
    }

    const findByUrl = database.prepare(
      "SELECT id FROM posts WHERE url = ? AND deleted_at IS NULL ORDER BY published_at DESC LIMIT 1",
    );
    const insert = database.prepare(`
      INSERT INTO posts
        (id, profile_id, published_at, body, url, visibility, source_checksum,
         source_kind, source_ref)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'archive', ?)
      ON CONFLICT(id) DO UPDATE SET
        published_at = excluded.published_at,
        body = excluded.body,
        url = excluded.url,
        visibility = excluded.visibility,
        source_checksum = excluded.source_checksum,
        source_kind = 'archive',
        source_ref = excluded.source_ref,
        deleted_at = NULL
    `);
    const updateReconciled = database.prepare(`
      UPDATE posts
      SET profile_id = ?, published_at = ?, body = ?, visibility = ?,
          source_checksum = ?, source_kind = 'archive', source_ref = ?,
          deleted_at = NULL
      WHERE id = ?
    `);
    let importedCount = 0;
    const commit = database.transaction(() => {
      database
        .prepare("INSERT OR IGNORE INTO metadata (key, value) VALUES ('profile_id', ?)")
        .run(profileId);
      database
        .prepare(
          "UPDATE posts SET deleted_at = ? WHERE profile_id = ? AND source_kind = 'archive' AND deleted_at IS NULL",
        )
        .run(new Date().toISOString(), profileId);
      for (const row of shares) {
        if (!row.Date) {
          throw new Error(`${sharesName} contains a row without Date`);
        }
        if (adapter === "linkedin-legacy" && !row.ShareCommentary) {
          throw new Error(`${sharesName} contains a row without ShareCommentary`);
        }
        if (adapter === "linkedin-2026" && !row.ShareCommentary) {
          continue;
        }
        importedCount += 1;
        const url = row.ShareLink || null;
        const existing = url
          ? (findByUrl.get(url) as { id: string } | undefined)
          : undefined;
        if (existing) {
          updateReconciled.run(
            profileId,
            row.Date,
            row.ShareCommentary ?? "",
            row.Visibility || null,
            archive.checksum,
            sharesName,
            existing.id,
          );
        } else {
          insert.run(
            postId(profileId, row),
            profileId,
            row.Date,
            row.ShareCommentary ?? "",
            url,
            row.Visibility || null,
            archive.checksum,
            sharesName,
          );
        }
      }
      database
        .prepare(
          "INSERT INTO imports (kind, checksum, fingerprint, imported_at) VALUES ('posts', ?, ?, ?)",
        )
        .run(archive.checksum, archive.fingerprint, new Date().toISOString());
    });
    commit();
    return {
      imported: importedCount,
      skipped: false,
      profileId,
      adapter,
    };
  } finally {
    database.close();
  }
}
