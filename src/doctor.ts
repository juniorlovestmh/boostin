import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { extname } from "node:path";

import { parse } from "csv-parse/sync";

import { readAllowedArchive } from "./archive.js";
import { getDatabasePath } from "./database.js";
import { getFileVaultStatus } from "./filevault.js";
import { readFirstWorksheet } from "./xlsx.js";

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
    const columns = workbook.rows[0] ?? [];
    return {
      kind: "first-party-analytics-workbook",
      schemaFingerprint: createHash("sha256")
        .update(JSON.stringify(columns))
        .digest("hex"),
      sheets: [{ name: "sheet1", columns, rowCount: Math.max(0, workbook.rows.length - 1) }],
    };
  }
  const archive = await readAllowedArchive(
    path,
    new Set(["Profile.csv", "Shares.csv"]),
  );
  const files = [...archive.entries.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, buffer]) => {
      const rows = parse(buffer, { bom: true, skip_empty_lines: true }) as string[][];
      return {
        name,
        columns: rows[0] ?? [],
        rowCount: Math.max(0, rows.length - 1),
      };
    });
  const schemaFingerprint = createHash("sha256")
    .update(JSON.stringify(files))
    .digest("hex");
  return { kind: "linkedin-account-archive", schemaFingerprint, files };
}
