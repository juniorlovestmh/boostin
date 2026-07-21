#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";

import { createBackup, restoreBackup } from "./backup.js";
import { openDatabase } from "./database.js";
import { fingerprintArchive, runDoctor } from "./doctor.js";
import { requireFileVaultForRealImport } from "./filevault.js";
import { importAnalytics } from "./import-analytics.js";
import { importPosts } from "./import-posts.js";
import { generateWeeklyReport } from "./report.js";
import {
  addOutcome,
  createDraft,
  listDrafts,
  recordProfileSnapshot,
} from "./state.js";

export function createProgram(): Command {
  const program = new Command()
    .name("boostin")
    .description("Local-first professional content analytics")
    .version("0.1.0");

  program
    .command("init")
    .description("Initialize local Boostin state")
    .option("--json", "Print machine-readable output")
    .action((options: { json?: boolean }) => {
      const { database, path, created } = openDatabase();
      database.close();
      const result = { database: path, created };
      process.stdout.write(
        options.json ? `${JSON.stringify(result)}\n` : `Initialized ${path}\n`,
      );
    });

  const importCommand = program.command("import");
  importCommand
    .command("analytics")
    .argument("<workbook>")
    .requiredOption("--captured-at <date>", "ISO timestamp for this snapshot")
    .option("--json", "Print machine-readable output")
    .description("Import first-party post analytics")
    .action(
      async (
        workbook: string,
        options: { capturedAt: string; json?: boolean },
      ) => {
        requireFileVaultForRealImport();
        const result = await importAnalytics(workbook, options.capturedAt);
        process.stdout.write(
          options.json
            ? `${JSON.stringify(result)}\n`
            : `Imported ${result.imported} analytics rows${result.skipped ? " (already imported)" : ""}.\n`,
        );
      },
    );

  importCommand
    .command("posts")
    .argument("<archive>")
    .description("Import the user's own posts from an official archive")
    .option("--json", "Print machine-readable output")
    .action(async (archive: string, options: { json?: boolean }) => {
      requireFileVaultForRealImport();
      const result = await importPosts(archive);
      process.stdout.write(
        options.json
          ? `${JSON.stringify(result)}\n`
          : `Imported ${result.imported} posts${result.skipped ? " (already imported)" : ""}.\n`,
      );
    });

  const reportCommand = program.command("report");
  reportCommand
    .command("weekly")
    .requiredOption("--week <monday>", "UTC Monday in YYYY-MM-DD format")
    .option("--private", "Generate a private report")
    .option("--public", "Generate an allowlisted public report")
    .option("--confirm-public", "Confirm human review of public output")
    .option("--out <path>", "Write the report to a file")
    .action(
      (options: {
        week: string;
        private?: boolean;
        public?: boolean;
        confirmPublic?: boolean;
        out?: string;
      }) => {
        if (Boolean(options.private) === Boolean(options.public)) {
          throw new Error("Choose exactly one of --private or --public");
        }
        const report = generateWeeklyReport({
          week: options.week,
          visibility: options.public ? "public" : "private",
          confirmedPublic: Boolean(options.confirmPublic),
          ...(options.out ? { out: options.out } : {}),
        });
        if (!options.out) process.stdout.write(report);
      },
    );

  const snapshotCommand = program.command("snapshot");
  snapshotCommand
    .command("profile")
    .requiredOption("--captured-at <date>")
    .option("--followers <count>")
    .option("--profile-views <count>")
    .option("--search-appearances <count>")
    .option("--json")
    .action(
      (options: {
        capturedAt: string;
        followers?: string;
        profileViews?: string;
        searchAppearances?: string;
        json?: boolean;
      }) => {
        requireFileVaultForRealImport();
        const result = recordProfileSnapshot(options);
        process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : "Profile snapshot recorded.\n");
      },
    );

  const draftCommand = program.command("draft");
  draftCommand
    .command("new")
    .requiredOption("--title <title>")
    .requiredOption("--body <body>")
    .option("--pillar <pillar>")
    .option("--audience <audience>")
    .option("--json")
    .action(
      (options: {
        title: string;
        body: string;
        pillar?: string;
        audience?: string;
        json?: boolean;
      }) => {
        requireFileVaultForRealImport();
        const result = createDraft(options);
        process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : `Draft ${result.id} created.\n`);
      },
    );
  draftCommand
    .command("list")
    .option("--json")
    .action((options: { json?: boolean }) => {
      requireFileVaultForRealImport();
      const drafts = listDrafts();
      process.stdout.write(options.json ? `${JSON.stringify(drafts)}\n` : `${drafts.length} drafts.\n`);
    });

  const outcomeCommand = program.command("outcome");
  outcomeCommand
    .command("add")
    .requiredOption("--occurred-at <date>")
    .requiredOption("--type <type>")
    .requiredOption("--count <count>")
    .option("--note <note>")
    .option("--json")
    .action(
      (options: {
        occurredAt: string;
        type: string;
        count: string;
        note?: string;
        json?: boolean;
      }) => {
        requireFileVaultForRealImport();
        const result = addOutcome(options);
        process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : `Outcome ${result.id} recorded.\n`);
      },
    );

  function readPassphrase(options: { passphraseStdin?: boolean }): string {
    if (!options.passphraseStdin) {
      throw new Error("Use --passphrase-stdin so the backup passphrase is not stored in shell history");
    }
    const passphrase = readFileSync(0, "utf8").replace(/[\r\n]+$/, "");
    if (!passphrase) throw new Error("No backup passphrase was provided on stdin");
    return passphrase;
  }

  const backupCommand = program.command("backup");
  backupCommand
    .command("create")
    .argument("<path>")
    .option("--passphrase-stdin")
    .option("--json")
    .action(async (path: string, options: { passphraseStdin?: boolean; json?: boolean }) => {
      requireFileVaultForRealImport();
      const result = await createBackup(path, readPassphrase(options));
      process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : `Backup created at ${result.backup}.\n`);
    });
  backupCommand
    .command("restore")
    .argument("<path>")
    .option("--passphrase-stdin")
    .option("--json")
    .action((path: string, options: { passphraseStdin?: boolean; json?: boolean }) => {
      requireFileVaultForRealImport();
      const result = restoreBackup(path, readPassphrase(options));
      process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : `Backup restored to ${result.database}.\n`);
    });

  program
    .command("doctor")
    .option("--fingerprint <path>", "Emit a value-free structural fingerprint")
    .option("--json")
    .action(async (options: { fingerprint?: string; json?: boolean }) => {
      const result = options.fingerprint
        ? await fingerprintArchive(options.fingerprint)
        : runDoctor();
      process.stdout.write(
        options.json ? `${JSON.stringify(result)}\n` : `${JSON.stringify(result, null, 2)}\n`,
      );
    });

  return program;
}

async function main(): Promise<void> {
  try {
    await createProgram().parseAsync(process.argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`boostin: ${message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
