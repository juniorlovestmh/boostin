import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { extname } from "node:path";

import { parse } from "csv-parse/sync";

import { readSelectedArchive } from "./archive.js";
import { getDatabasePath } from "./database.js";
import { getFileVaultStatus } from "./filevault.js";
import { readFirstWorksheet } from "./xlsx.js";

const ANALYTICS_FIELDS = new Set([
  "Post URL",
  "Impressions",
  "Members reached",
  "Reactions",
  "Comments",
  "Reposts",
  "Saves",
  "Sends",
  "Out-of-network %",
]);

const PROFILE_FIELDS = new Set([
  "First Name",
  "Last Name",
  "Public Profile URL",
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
]);
const SHARE_FIELDS = new Set([
  "Date",
  "ShareLink",
  "ShareCommentary",
  "SharedUrl",
  "MediaUrl",
  "Visibility",
]);

export interface DoctorResult {
  fileVault: string;
  databaseExists: boolean;
  databasePermissions: string | null;
  readyForRealData: boolean;
}

export function runDoctor(): DoctorResult {
  const fileVault = getFileVaultStatus();
  const path = getDatabasePath();
  const databaseExists = existsSync(path);
  const databasePermissions = databaseExists
    ? (statSync(path).mode & 0o777).toString(8).padStart(3, "0")
    : null;
  return {
    fileVault,
    databaseExists,
    databasePermissions,
    readyForRealData: fileVault === "On" && (!databaseExists || databasePermissions === "600"),
  };
}

export async function fingerprintArchive(path: string): Promise<Record<string, unknown>> {
  if (extname(path).toLowerCase() === ".xlsx") {
    const workbook = await readFirstWorksheet(path);
    const recognizedFields = [
      ...new Set(workbook.rows.flat().filter((cell) => ANALYTICS_FIELDS.has(cell))),
    ].sort();
    const dimensions = {
      rowCount: workbook.rows.length,
      columnCount: Math.max(0, ...workbook.rows.map((row) => row.length)),
    };
    return {
      kind: "first-party-analytics-workbook",
      schemaFingerprint: createHash("sha256")
        .update(JSON.stringify({ recognizedFields, dimensions }))
        .digest("hex"),
      sheets: [{ name: "sheet1", recognizedFields, ...dimensions }],
    };
  }
  const archive = await readSelectedArchive(
    path,
    (name) =>
      name === "Profile.csv" || /^Shares(?:_[0-9]+)?\.csv$/.test(name),
  );
  const files = [...archive.entries.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, buffer]) => {
      const rows = parse(buffer, { bom: true, skip_empty_lines: true }) as string[][];
      const header = rows[0] ?? [];
      const fields = name === "Profile.csv" ? PROFILE_FIELDS : SHARE_FIELDS;
      const recognizedColumns = [
        ...new Set(rows.flat().filter((cell) => fields.has(cell))),
      ].sort();
      return {
        name: /^Shares_[0-9]+\.csv$/.test(name)
          ? "Shares_<member-id>.csv"
          : name,
        recognizedColumns,
        columnCount: header.length,
        rowCount: Math.max(0, rows.length - 1),
      };
    });
  const schemaFingerprint = createHash("sha256")
    .update(JSON.stringify(files))
    .digest("hex");
  return { kind: "linkedin-account-archive", schemaFingerprint, files };
}
