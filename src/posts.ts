import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

import { openDatabase } from "./database.js";

const MAX_POST_BODY_BYTES = 1024 * 1024;

function requireHttpsUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS`);
  return url.toString();
}

export function addPost(input: {
  url: string;
  publishedAt: string;
  bodyFile: string;
  source: string;
}): { id: string; source: "manual"; skipped: boolean } {
  if (input.source !== "manual") {
    throw new Error("source must be manual");
  }
  if (Number.isNaN(Date.parse(input.publishedAt))) {
    throw new Error("published-at must be an ISO date");
  }
  const url = requireHttpsUrl(input.url, "url");
  const stats = statSync(input.bodyFile);
  if (!stats.isFile() || stats.size > MAX_POST_BODY_BYTES) {
    throw new Error("body-file must be a regular file no larger than 1 MB");
  }
  const body = readFileSync(input.bodyFile, "utf8").trim();
  if (!body) throw new Error("body-file must not be empty");
  const { database } = openDatabase();
  try {
    const bound = database
      .prepare("SELECT value FROM metadata WHERE key = 'profile_id'")
      .get() as { value: string } | undefined;
    if (!bound) {
      throw new Error("Import an official LinkedIn archive before adding a manual post");
    }
    const existing = database
      .prepare("SELECT id FROM posts WHERE url = ? LIMIT 1")
      .get(url) as { id: string } | undefined;
    if (existing) return { id: existing.id, source: "manual", skipped: true };
    const checksum = createHash("sha256")
      .update([bound.value, input.publishedAt, url, body].join("\0"))
      .digest("hex");
    const id = checksum;
    database
      .prepare(`
        INSERT INTO posts
          (id, profile_id, published_at, body, url, visibility, source_checksum,
           source_kind, source_ref)
        VALUES (?, ?, ?, ?, ?, NULL, ?, 'manual', ?)
      `)
      .run(
        id,
        bound.value,
        new Date(input.publishedAt).toISOString(),
        body,
        url,
        `manual:${checksum}`,
        input.bodyFile,
      );
    return { id, source: "manual", skipped: false };
  } finally {
    database.close();
  }
}
