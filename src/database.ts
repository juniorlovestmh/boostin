import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

export function getBoostinHome(): string {
  return (
    process.env.BOOSTIN_HOME ??
    join(homedir(), "Library", "Application Support", "Boostin")
  );
}

export function getDatabasePath(): string {
  return join(getBoostinHome(), "boostin.db");
}

export interface OpenDatabaseResult {
  database: Database.Database;
  path: string;
  created: boolean;
}

function createCurrentSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS imports (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,
      checksum TEXT NOT NULL UNIQUE,
      fingerprint TEXT NOT NULL,
      imported_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      published_at TEXT NOT NULL,
      body TEXT NOT NULL,
      url TEXT,
      visibility TEXT,
      source_checksum TEXT NOT NULL,
      source_kind TEXT NOT NULL DEFAULT 'archive',
      source_ref TEXT,
      deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS analytics_snapshots (
      id INTEGER PRIMARY KEY,
      post_id TEXT NOT NULL REFERENCES posts(id),
      captured_at TEXT NOT NULL,
      impressions INTEGER NOT NULL,
      members_reached INTEGER,
      reactions INTEGER NOT NULL,
      comments INTEGER NOT NULL,
      reposts INTEGER NOT NULL,
      saves INTEGER,
      sends INTEGER,
      out_of_network_percent REAL,
      UNIQUE(post_id, captured_at)
    );
    CREATE TABLE IF NOT EXISTS profile_snapshots (
      captured_at TEXT PRIMARY KEY,
      followers INTEGER,
      profile_views INTEGER,
      search_appearances INTEGER
    );
    CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      pillar TEXT,
      audience TEXT,
      status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outcomes (
      id TEXT PRIMARY KEY,
      campaign_id TEXT REFERENCES campaigns(id),
      occurred_at TEXT NOT NULL,
      type TEXT NOT NULL,
      count INTEGER NOT NULL,
      note TEXT
    );
    CREATE TABLE IF NOT EXISTS graph_runs (
      id TEXT PRIMARY KEY,
      corpus TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL,
      backend TEXT NOT NULL,
      model TEXT NOT NULL,
      graphify_version TEXT,
      corpus_path TEXT NOT NULL,
      output_path TEXT NOT NULL,
      graph_checksum TEXT,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      article_url TEXT NOT NULL,
      post_url TEXT NOT NULL,
      published_at TEXT NOT NULL,
      timezone TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS checkpoints (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      due_at TEXT NOT NULL,
      completed_at TEXT,
      captured_at TEXT,
      notified_at TEXT,
      UNIQUE(campaign_id, name)
    );
    CREATE INDEX IF NOT EXISTS posts_url_idx ON posts(url);
    CREATE INDEX IF NOT EXISTS checkpoints_due_idx
      ON checkpoints(completed_at, due_at);
  `);
}

function migrate(database: Database.Database, path: string, created: boolean): Database.Database {
  const version = database.pragma("user_version", { simple: true }) as number;
  if (version > 3) {
    database.close();
    throw new Error(`Database schema version ${version} is newer than this Boostin build`);
  }
  if (version === 0) {
    const apply = database.transaction(() => {
      createCurrentSchema(database);
      database.pragma("user_version = 3");
    });
    apply();
    return database;
  }
  if (version === 1) {
    database.pragma("wal_checkpoint(TRUNCATE)");
    database.close();
    const backup = `${path}.pre-v2.bak`;
    if (!created && !existsSync(backup)) {
      copyFileSync(path, backup, constants.COPYFILE_EXCL);
      chmodSync(backup, 0o600);
    }
    const reopened = new Database(path);
    reopened.pragma("journal_mode = WAL");
    reopened.pragma("foreign_keys = ON");
    const apply = reopened.transaction(() => {
      reopened.exec(`
        ALTER TABLE posts ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'archive';
        ALTER TABLE posts ADD COLUMN source_ref TEXT;
      `);
      createCurrentSchema(reopened);
      reopened.pragma("user_version = 3");
    });
    try {
      apply();
      return reopened;
    } catch (error) {
      reopened.close();
      throw error;
    }
  }
  if (version === 2) {
    database.exec("ALTER TABLE outcomes ADD COLUMN campaign_id TEXT REFERENCES campaigns(id)");
    database.pragma("user_version = 3");
  }
  createCurrentSchema(database);
  return database;
}

export function openDatabase(): OpenDatabaseResult {
  const home = getBoostinHome();
  const path = getDatabasePath();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const created = !existsSync(path);
  let database = new Database(path);
  chmodSync(path, 0o600);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database = migrate(database, path, created);
  return { database, path, created };
}
