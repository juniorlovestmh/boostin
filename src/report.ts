import { chmodSync, writeFileSync } from "node:fs";

import { openDatabase } from "./database.js";

interface MetricRow {
  published_at: string;
  body: string;
  impressions: number;
  members_reached: number | null;
  reactions: number;
  comments: number;
  reposts: number;
  saves: number | null;
  sends: number | null;
  out_of_network_percent: number | null;
}

export interface WeeklyReportOptions {
  week: string;
  visibility: "private" | "public";
  confirmedPublic: boolean;
  out?: string;
}

function weekBounds(week: string): [string, string] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) throw new Error("week must use YYYY-MM-DD");
  const start = new Date(`${week}T00:00:00.000Z`);
  if (Number.isNaN(start.valueOf()) || start.getUTCDay() !== 1) {
    throw new Error("week must be a valid Monday in UTC");
  }
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  return [start.toISOString(), end.toISOString()];
}

function sum(rows: MetricRow[], key: keyof MetricRow): number {
  return rows.reduce((total, row) => {
    const value = row[key];
    return total + (typeof value === "number" ? value : 0);
  }, 0);
}

function renderAggregate(week: string, rows: MetricRow[]): string[] {
  const reach = sum(rows, "members_reached");
  const outValues = rows
    .map((row) => row.out_of_network_percent)
    .filter((value): value is number => value !== null);
  const outAverage =
    outValues.length === 0
      ? "N/A"
      : `${(outValues.reduce((a, b) => a + b, 0) / outValues.length).toFixed(1)}%`;
  return [
    `Week: ${week}`,
    `Posts measured: ${rows.length}`,
    `Impressions: ${sum(rows, "impressions")}`,
    `Members reached: ${reach}`,
    `Reactions: ${sum(rows, "reactions")}`,
    `Comments: ${sum(rows, "comments")}`,
    `Reposts: ${sum(rows, "reposts")}`,
    `Saves: ${sum(rows, "saves")}`,
    `Sends: ${sum(rows, "sends")}`,
    `Average out-of-network reach: ${outAverage}`,
  ];
}

export function generateWeeklyReport(options: WeeklyReportOptions): string {
  if (options.visibility === "public" && !options.confirmedPublic) {
    throw new Error("Public report generation requires --confirm-public");
  }
  const [start, end] = weekBounds(options.week);
  const { database } = openDatabase();
  try {
    const rows = database
      .prepare(`
        SELECT p.published_at, p.body, a.impressions, a.members_reached,
               a.reactions, a.comments, a.reposts, a.saves, a.sends,
               a.out_of_network_percent
        FROM analytics_snapshots a
        JOIN posts p ON p.id = a.post_id
        WHERE a.captured_at >= ? AND a.captured_at < ?
          AND a.captured_at = (
            SELECT MAX(latest.captured_at)
            FROM analytics_snapshots latest
            WHERE latest.post_id = a.post_id
              AND latest.captured_at >= ? AND latest.captured_at < ?
          )
        ORDER BY p.published_at, p.id
      `)
      .all(start, end, start, end) as MetricRow[];
    const title =
      options.visibility === "private"
        ? "# Boostin private weekly review"
        : "# Boostin public weekly review";
    const lines = [title, "", ...renderAggregate(options.week, rows)];
    if (options.visibility === "private") {
      lines.push("", "## Posts");
      for (const row of rows) {
        lines.push(
          "",
          `### ${row.published_at}`,
          "",
          row.body,
          "",
          `- Impressions: ${row.impressions}`,
          `- Reactions: ${row.reactions}`,
          `- Comments: ${row.comments}`,
          `- Saves: ${row.saves ?? "N/A"}`,
        );
      }
    } else {
      lines.push(
        "",
        "This report contains allowlisted aggregate metrics only. It includes no post text, drafts, URLs, profile identifiers, or private notes.",
      );
    }
    const report = `${lines.join("\n")}\n`;
    if (options.out) {
      writeFileSync(options.out, report, { mode: options.visibility === "private" ? 0o600 : 0o644 });
      chmodSync(options.out, options.visibility === "private" ? 0o600 : 0o644);
    }
    return report;
  } finally {
    database.close();
  }
}
