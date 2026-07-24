import { randomUUID } from "node:crypto";

import { openDatabase } from "./database.js";

function optionalCount(value: string | undefined, label: string): number | null {
  if (value === undefined) return null;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0) throw new Error(`${label} must be a nonnegative integer`);
  return count;
}

export function recordProfileSnapshot(input: {
  capturedAt: string;
  followers?: string;
  profileViews?: string;
  searchAppearances?: string;
}): { recorded: true } {
  if (Number.isNaN(Date.parse(input.capturedAt))) throw new Error("captured-at must be an ISO date");
  const { database } = openDatabase();
  try {
    database
      .prepare(`
        INSERT INTO profile_snapshots
          (captured_at, followers, profile_views, search_appearances)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(captured_at) DO UPDATE SET
          followers = excluded.followers,
          profile_views = excluded.profile_views,
          search_appearances = excluded.search_appearances
      `)
      .run(
        input.capturedAt,
        optionalCount(input.followers, "followers"),
        optionalCount(input.profileViews, "profile-views"),
        optionalCount(input.searchAppearances, "search-appearances"),
      );
    return { recorded: true };
  } finally {
    database.close();
  }
}

export function createDraft(input: {
  title: string;
  body: string;
  pillar?: string;
  audience?: string;
}): { id: string; status: "drafting" } {
  if (!input.title.trim() || !input.body.trim()) throw new Error("title and body are required");
  const id = randomUUID();
  const now = new Date().toISOString();
  const { database } = openDatabase();
  try {
    database
      .prepare(`
        INSERT INTO drafts
          (id, created_at, updated_at, title, body, pillar, audience, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'drafting')
      `)
      .run(
        id,
        now,
        now,
        input.title,
        input.body,
        input.pillar ?? null,
        input.audience ?? null,
      );
    return { id, status: "drafting" };
  } finally {
    database.close();
  }
}

export function listDrafts(): Array<Record<string, unknown>> {
  const { database } = openDatabase();
  try {
    return database
      .prepare(
        "SELECT id, created_at, updated_at, title, pillar, audience, status FROM drafts ORDER BY created_at, id",
      )
      .all() as Array<Record<string, unknown>>;
  } finally {
    database.close();
  }
}

export function addOutcome(input: {
  campaign?: string;
  occurredAt: string;
  type: string;
  count: string;
  note?: string;
}): { id: string; count: number } {
  if (Number.isNaN(Date.parse(input.occurredAt))) throw new Error("occurred-at must be a date");
  const count = optionalCount(input.count, "count");
  if (count === null || count === 0) throw new Error("count must be a positive integer");
  const id = randomUUID();
  const { database } = openDatabase();
  try {
    const campaignId = input.campaign
      ? (database.prepare("SELECT id FROM campaigns WHERE slug = ?").get(input.campaign) as { id: string } | undefined)?.id
      : null;
    if (input.campaign && !campaignId) throw new Error(`Unknown campaign: ${input.campaign}`);
    database
      .prepare("INSERT INTO outcomes (id, campaign_id, occurred_at, type, count, note) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, campaignId ?? null, input.occurredAt, input.type, count, input.note ?? null);
    return { id, count };
  } finally {
    database.close();
  }
}
