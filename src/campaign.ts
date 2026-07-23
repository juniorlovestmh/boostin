import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { getBoostinHome, openDatabase } from "./database.js";

const CHECKPOINTS = [
  { name: "24h", milliseconds: 24 * 60 * 60 * 1000 },
  { name: "72h", milliseconds: 72 * 60 * 60 * 1000 },
  { name: "7d", milliseconds: 7 * 24 * 60 * 60 * 1000 },
  { name: "30d", milliseconds: 30 * 24 * 60 * 60 * 1000 },
] as const;

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

function now(): Date {
  const value = process.env.BOOSTIN_NOW;
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.valueOf())) throw new Error("BOOSTIN_NOW must be an ISO date");
  return date;
}

export function startCampaign(input: {
  slug: string;
  articleUrl: string;
  postUrl: string;
  publishedAt: string;
  timezone?: string;
}): {
  slug: string;
  checkpoints: Array<{ name: string; dueAt: string }>;
} {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug)) {
    throw new Error("slug must use lowercase letters, numbers, and hyphens");
  }
  const published = new Date(input.publishedAt);
  if (Number.isNaN(published.valueOf())) {
    throw new Error("published-at must be an ISO date with an explicit offset");
  }
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(input.publishedAt)) {
    throw new Error("published-at must include a timezone offset");
  }
  const articleUrl = requireHttpsUrl(input.articleUrl, "article-url");
  const postUrl = requireHttpsUrl(input.postUrl, "post-url");
  const timezone = input.timezone ?? "America/Sao_Paulo";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(published);
  } catch {
    throw new Error(`timezone must be a valid IANA timezone: ${timezone}`);
  }
  const id = randomUUID();
  const checkpoints = CHECKPOINTS.map((checkpoint) => ({
    name: checkpoint.name,
    dueAt: new Date(published.valueOf() + checkpoint.milliseconds).toISOString(),
  }));
  const { database } = openDatabase();
  try {
    const commit = database.transaction(() => {
      database
        .prepare(`
          INSERT INTO campaigns
            (id, slug, article_url, post_url, published_at, timezone, created_at, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
        `)
        .run(
          id,
          input.slug,
          articleUrl,
          postUrl,
          published.toISOString(),
          timezone,
          now().toISOString(),
        );
      const insert = database.prepare(`
        INSERT INTO checkpoints (id, campaign_id, name, due_at)
        VALUES (?, ?, ?, ?)
      `);
      for (const checkpoint of checkpoints) {
        insert.run(randomUUID(), id, checkpoint.name, checkpoint.dueAt);
      }
    });
    commit();
    return { slug: input.slug, checkpoints };
  } finally {
    database.close();
  }
}

export function dueCheckpoints(): Array<Record<string, unknown>> {
  const current = now().toISOString();
  const { database } = openDatabase();
  try {
    const rows = database
      .prepare(`
        SELECT c.slug AS campaign, cp.name AS checkpoint, cp.due_at AS dueAt,
               c.article_url AS articleUrl, c.post_url AS postUrl
        FROM checkpoints cp
        JOIN campaigns c ON c.id = cp.campaign_id
        WHERE c.status = 'active'
          AND cp.completed_at IS NULL
          AND cp.due_at <= ?
        ORDER BY cp.due_at, c.slug, cp.name
      `)
      .all(current) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ ...row, overdue: true }));
  } finally {
    database.close();
  }
}

export function completeCheckpoint(input: {
  campaign: string;
  name: string;
  capturedAt: string;
}): { completed: true; campaign: string; checkpoint: string } {
  if (Number.isNaN(Date.parse(input.capturedAt))) {
    throw new Error("captured-at must be an ISO date");
  }
  const { database } = openDatabase();
  try {
    const result = database
      .prepare(`
        UPDATE checkpoints
        SET completed_at = ?, captured_at = ?
        WHERE campaign_id = (SELECT id FROM campaigns WHERE slug = ?)
          AND name = ?
      `)
      .run(now().toISOString(), new Date(input.capturedAt).toISOString(), input.campaign, input.name);
    if (result.changes !== 1) {
      throw new Error(`Unknown campaign checkpoint: ${input.campaign}/${input.name}`);
    }
    return { completed: true, campaign: input.campaign, checkpoint: input.name };
  } finally {
    database.close();
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function installReminders(): { plist: string; installed: true } {
  const directory =
    process.env.BOOSTIN_LAUNCH_AGENTS_DIR ??
    join(homedir(), "Library", "LaunchAgents");
  mkdirSync(directory, { recursive: true, mode: 0o755 });
  const plist = join(directory, "co.appheat.boostin.reminders.plist");
  const cliPath = process.env.BOOSTIN_CLI_PATH ?? process.argv[1];
  if (!cliPath) throw new Error("Unable to resolve the Boostin executable");
  const log = join(getBoostinHome(), "reminders.log");
  const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>co.appheat.boostin.reminders</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(cliPath)}</string>
    <string>reminders</string>
    <string>notify</string>
  </array>
  <key>StartInterval</key><integer>3600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(log)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(log)}</string>
</dict>
</plist>
`;
  writeFileSync(plist, contents, { mode: 0o644 });
  chmodSync(plist, 0o644);
  if (process.env.BOOSTIN_SKIP_LAUNCHCTL !== "1") {
    const domain = `gui/${process.getuid?.() ?? 0}`;
    spawnSync("launchctl", ["bootout", `${domain}/co.appheat.boostin.reminders`], {
      encoding: "utf8",
    });
    const loaded = spawnSync("launchctl", ["bootstrap", domain, plist], {
      encoding: "utf8",
    });
    if (loaded.error || loaded.status !== 0) {
      throw new Error(
        `Unable to load Boostin reminders: ${(loaded.stderr || loaded.error?.message || "").trim()}`,
      );
    }
  }
  return { plist, installed: true };
}

export function notifyDueCheckpoints(): { notified: number } {
  const due = dueCheckpoints();
  const { database } = openDatabase();
  let notified = 0;
  try {
    const wasNotified = database.prepare(
      `
        SELECT cp.notified_at
        FROM checkpoints cp
        JOIN campaigns c ON c.id = cp.campaign_id
        WHERE c.slug = ? AND cp.name = ?
      `,
    );
    const mark = database.prepare(`
      UPDATE checkpoints
      SET notified_at = ?
      WHERE campaign_id = (SELECT id FROM campaigns WHERE slug = ?)
        AND name = ?
    `);
    for (const item of due) {
      const campaign = String(item.campaign);
      const checkpoint = String(item.checkpoint);
      const row = wasNotified.get(campaign, checkpoint) as
        | { notified_at: string | null }
        | undefined;
      if (!row || row.notified_at) continue;
      const script = `display notification ${JSON.stringify(
        `Export LinkedIn analytics for ${campaign} (${checkpoint})`,
      )} with title "Boostin checkpoint due"`;
      const result = spawnSync("osascript", ["-e", script], { encoding: "utf8" });
      if (result.error || result.status !== 0) {
        throw new Error("Unable to display a Boostin reminder");
      }
      mark.run(now().toISOString(), campaign, checkpoint);
      notified += 1;
    }
    return { notified };
  } finally {
    database.close();
  }
}

export function campaignReport(input: {
  slug: string;
  out?: string;
}): string {
  const { database } = openDatabase();
  try {
    const campaign = database
      .prepare(`
        SELECT id, slug, article_url, post_url, published_at, timezone, status
        FROM campaigns WHERE slug = ?
      `)
      .get(input.slug) as
      | {
          id: string;
          slug: string;
          article_url: string;
          post_url: string;
          published_at: string;
          timezone: string;
          status: string;
        }
      | undefined;
    if (!campaign) throw new Error(`Unknown campaign: ${input.slug}`);
    const checkpoints = database
      .prepare(`
        SELECT name, due_at, completed_at, captured_at
        FROM checkpoints
        WHERE campaign_id = ?
        ORDER BY due_at
      `)
      .all(campaign.id) as Array<{
      name: string;
      due_at: string;
      completed_at: string | null;
      captured_at: string | null;
    }>;
    const analytics = database
      .prepare(`
        SELECT a.captured_at, a.impressions, a.members_reached, a.reactions,
               a.comments, a.reposts, a.saves, a.sends,
               a.out_of_network_percent
        FROM analytics_snapshots a
        JOIN posts p ON p.id = a.post_id
        WHERE p.url = ?
        ORDER BY a.captured_at DESC
        LIMIT 1
      `)
      .get(campaign.post_url) as Record<string, unknown> | undefined;
    const analyticsAt = database.prepare(`
      SELECT a.captured_at, a.impressions, a.members_reached, a.reactions,
             a.comments, a.reposts, a.saves, a.sends,
             a.out_of_network_percent
      FROM analytics_snapshots a
      JOIN posts p ON p.id = a.post_id
      WHERE p.url = ? AND a.captured_at <= ?
      ORDER BY a.captured_at DESC
      LIMIT 1
    `);
    const outcomes = database
      .prepare(`
        SELECT type, SUM(count) AS count
        FROM outcomes
        WHERE occurred_at >= ?
        GROUP BY type
        ORDER BY type
      `)
      .all(campaign.published_at) as Array<{ type: string; count: number }>;
    const lines = [
      "# Boostin private campaign report",
      "",
      `Campaign: ${campaign.slug}`,
      `Status: ${campaign.status}`,
      `Published: ${campaign.published_at}`,
      `Article: ${campaign.article_url}`,
      `LinkedIn post: ${campaign.post_url}`,
      "",
      "## Checkpoints",
      "",
      ...checkpoints.flatMap((checkpoint) => {
        const line = `- ${checkpoint.name}: ${checkpoint.completed_at ? `completed ${checkpoint.completed_at}` : `due ${checkpoint.due_at}`}${
          checkpoint.captured_at ? `, analytics captured ${checkpoint.captured_at}` : ""
        }`;
        if (!checkpoint.captured_at) return [line];
        const snapshot = analyticsAt.get(
          campaign.post_url,
          checkpoint.captured_at,
        ) as Record<string, unknown> | undefined;
        if (!snapshot) return [line, "  - No imported snapshot available at this checkpoint."];
        return [
          line,
          `  - Impressions: ${snapshot.impressions}`,
          `  - Members reached: ${snapshot.members_reached ?? "N/A"}`,
          `  - Reactions: ${snapshot.reactions}`,
          `  - Comments: ${snapshot.comments}`,
          `  - Reposts: ${snapshot.reposts}`,
          `  - Saves: ${snapshot.saves ?? "N/A"}`,
          `  - Sends: ${snapshot.sends ?? "N/A"}`,
          `  - Out-of-network reach: ${snapshot.out_of_network_percent ?? "N/A"}`,
        ];
      }),
      "",
      "## Latest imported analytics",
      "",
      analytics
        ? Object.entries(analytics)
            .map(([key, value]) => `- ${key}: ${value ?? "N/A"}`)
            .join("\n")
        : "No analytics workbook has been imported for this post.",
      "",
      "## Self-reported qualified outcomes",
      "",
      outcomes.length > 0
        ? outcomes.map((outcome) => `- ${outcome.type}: ${outcome.count}`).join("\n")
        : "No outcomes recorded.",
      "",
      "This private report does not imply that the campaign caused any observed outcome.",
      "",
    ];
    const report = lines.join("\n");
    if (input.out) {
      writeFileSync(input.out, report, { mode: 0o600 });
      chmodSync(input.out, 0o600);
    }
    return report;
  } finally {
    database.close();
  }
}
