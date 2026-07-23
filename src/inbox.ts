import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { extname, join } from "node:path";

import { getBoostinHome } from "./database.js";
import { importAnalytics } from "./import-analytics.js";
import { importPosts } from "./import-posts.js";

export async function processInbox(input: {
  capturedAt?: string;
}): Promise<{ processed: number; posts: number; analytics: number }> {
  if (
    input.capturedAt !== undefined &&
    Number.isNaN(Date.parse(input.capturedAt))
  ) {
    throw new Error("captured-at must be an ISO date");
  }
  const inbox = join(getBoostinHome(), "inbox");
  const processedDirectory = join(inbox, "processed");
  mkdirSync(processedDirectory, { recursive: true, mode: 0o700 });
  chmodSync(inbox, 0o700);
  chmodSync(processedDirectory, 0o700);
  const entries = readdirSync(inbox)
    .filter((name) => name !== "processed")
    .sort();
  const files = entries.map((name) => {
    const path = join(inbox, name);
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Inbox entries must be regular files: ${name}`);
    }
    const extension = extname(name).toLowerCase();
    if (extension !== ".zip" && extension !== ".xlsx") {
      throw new Error(`Unsupported inbox file: ${name}`);
    }
    if (extension === ".xlsx" && !input.capturedAt) {
      throw new Error(
        "Analytics inbox files require --captured-at so snapshots are not misdated",
      );
    }
    return { name, path, extension };
  });

  let posts = 0;
  let analytics = 0;
  for (const file of files) {
    if (file.extension === ".zip") {
      const result = await importPosts(file.path);
      posts += result.imported;
    } else {
      const result = await importAnalytics(file.path, input.capturedAt!);
      analytics += result.imported;
    }
    const archived = join(
      processedDirectory,
      `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}-${file.name}`,
    );
    renameSync(file.path, archived);
    chmodSync(archived, 0o600);
  }
  return { processed: files.length, posts, analytics };
}
