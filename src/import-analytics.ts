import { openDatabase } from "./database.js";
import { readFirstWorksheet } from "./xlsx.js";

const EXPECTED_COLUMNS = [
  "Post URL",
  "Impressions",
  "Members reached",
  "Reactions",
  "Comments",
  "Reposts",
  "Saves",
  "Sends",
  "Out-of-network %",
] as const;

type MetricName = (typeof EXPECTED_COLUMNS)[number];
type AnalyticsRow = Record<MetricName, string>;

export interface ImportAnalyticsResult {
  imported: number;
  skipped: boolean;
}

function parseNonnegative(value: string, label: string, optional = false): number | null {
  if (optional && value === "") return null;
  const number = Number(value.replaceAll(",", ""));
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return number;
}

function parsePercent(value: string): number | null {
  if (value === "") return null;
  const number = Number(value.replace("%", ""));
  if (!Number.isFinite(number) || number < 0 || number > 100) {
    throw new Error(`Invalid out-of-network percentage: ${JSON.stringify(value)}`);
  }
  return number;
}

function rowsToRecords(rows: string[][]): AnalyticsRow[] {
  const header = rows[0] ?? [];
  const missing = EXPECTED_COLUMNS.filter((column) => !header.includes(column));
  const unexpected = header.filter(
    (column) => !EXPECTED_COLUMNS.includes(column as MetricName),
  );
  if (missing.length > 0 || unexpected.length > 0 || header.length !== EXPECTED_COLUMNS.length) {
    throw new Error(
      `Analytics schema mismatch; missing=[${missing.join(",")}] unexpected=[${unexpected.join(",")}]`,
    );
  }
  return rows.slice(1).filter((row) => row.some(Boolean)).map((row) => {
    const record = {} as AnalyticsRow;
    for (const column of EXPECTED_COLUMNS) {
      record[column] = row[header.indexOf(column)] ?? "";
    }
    return record;
  });
}

export async function importAnalytics(
  path: string,
  capturedAt: string,
): Promise<ImportAnalyticsResult> {
  if (Number.isNaN(Date.parse(capturedAt))) throw new Error("captured-at must be an ISO date");
  const workbook = await readFirstWorksheet(path);
  const rows = rowsToRecords(workbook.rows);
  const { database } = openDatabase();
  try {
    if (database.prepare("SELECT 1 FROM imports WHERE checksum = ?").get(workbook.checksum)) {
      return { imported: 0, skipped: true };
    }
    const findPost = database.prepare("SELECT id FROM posts WHERE url = ? AND deleted_at IS NULL");
    const insert = database.prepare(`
      INSERT INTO analytics_snapshots
        (post_id, captured_at, impressions, members_reached, reactions, comments,
         reposts, saves, sends, out_of_network_percent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const commit = database.transaction(() => {
      for (const row of rows) {
        const post = findPost.get(row["Post URL"]) as { id: string } | undefined;
        if (!post) throw new Error(`Analytics references an unknown post URL: ${row["Post URL"]}`);
        insert.run(
          post.id,
          capturedAt,
          parseNonnegative(row.Impressions, "impressions"),
          parseNonnegative(row["Members reached"], "members reached", true),
          parseNonnegative(row.Reactions, "reactions"),
          parseNonnegative(row.Comments, "comments"),
          parseNonnegative(row.Reposts, "reposts"),
          parseNonnegative(row.Saves, "saves", true),
          parseNonnegative(row.Sends, "sends", true),
          parsePercent(row["Out-of-network %"]),
        );
      }
      database
        .prepare(
          "INSERT INTO imports (kind, checksum, fingerprint, imported_at) VALUES ('analytics', ?, ?, ?)",
        )
        .run(workbook.checksum, workbook.fingerprint, new Date().toISOString());
    });
    commit();
    return { imported: rows.length, skipped: false };
  } finally {
    database.close();
  }
}
