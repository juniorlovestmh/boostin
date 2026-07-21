import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

import { getBoostinHome, getDatabasePath, openDatabase } from "./database.js";

const MAGIC = Buffer.from("BOOSTIN1", "ascii");
const SCRYPT = { N: 131_072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } as const;

interface BackupHeader {
  version: 1;
  cipher: "aes-256-gcm";
  kdf: "scrypt";
  salt: string;
  iv: string;
  tag: string;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  if (passphrase.length < 12) throw new Error("Backup passphrase must be at least 12 characters");
  return scryptSync(passphrase, salt, 32, SCRYPT);
}

function encrypt(plaintext: Buffer, passphrase: string): Buffer {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const header: BackupHeader = {
    version: 1,
    cipher: "aes-256-gcm",
    kdf: "scrypt",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
  key.fill(0);
  const encodedHeader = Buffer.from(JSON.stringify(header), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(encodedHeader.length);
  return Buffer.concat([MAGIC, length, encodedHeader, ciphertext]);
}

function decrypt(envelope: Buffer, passphrase: string): Buffer {
  if (!envelope.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("Not a Boostin backup");
  }
  const headerLength = envelope.readUInt32BE(MAGIC.length);
  if (headerLength < 1 || headerLength > 4096) throw new Error("Invalid backup header");
  const headerStart = MAGIC.length + 4;
  const headerEnd = headerStart + headerLength;
  const header = JSON.parse(envelope.subarray(headerStart, headerEnd).toString("utf8")) as BackupHeader;
  if (header.version !== 1 || header.cipher !== "aes-256-gcm" || header.kdf !== "scrypt") {
    throw new Error("Unsupported backup format");
  }
  const salt = Buffer.from(header.salt, "base64");
  const iv = Buffer.from(header.iv, "base64");
  const tag = Buffer.from(header.tag, "base64");
  const key = deriveKey(passphrase, salt);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(envelope.subarray(headerEnd)),
      decipher.final(),
    ]);
  } catch {
    throw new Error("Backup authentication failed; the passphrase or file is incorrect");
  } finally {
    key.fill(0);
  }
}

function verifySqlite(data: Buffer): void {
  if (data.subarray(0, 16).toString("binary") !== "SQLite format 3\0") {
    throw new Error("Backup does not contain a SQLite database");
  }
}

export async function createBackup(path: string, passphrase: string): Promise<{ backup: string }> {
  if (existsSync(path)) throw new Error(`Backup already exists: ${path}`);
  const scratch = mkdtempSync(join(tmpdir(), "boostin-backup-"));
  const snapshot = join(scratch, "snapshot.db");
  const output = `${path}.tmp`;
  const { database } = openDatabase();
  try {
    await database.backup(snapshot);
  } finally {
    database.close();
  }
  try {
    const plaintext = readFileSync(snapshot);
    const envelope = encrypt(plaintext, passphrase);
    const verified = decrypt(envelope, passphrase);
    verifySqlite(verified);
    verified.fill(0);
    plaintext.fill(0);
    writeFileSync(output, envelope, { mode: 0o600, flag: "wx" });
    chmodSync(output, 0o600);
    renameSync(output, path);
    return { backup: path };
  } finally {
    rmSync(output, { force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function restoreBackup(path: string, passphrase: string): { database: string } {
  const databasePath = getDatabasePath();
  if (existsSync(databasePath)) throw new Error("A Boostin database already exists; restore requires an empty home");
  const envelope = readFileSync(path);
  const plaintext = decrypt(envelope, passphrase);
  verifySqlite(plaintext);
  const home = getBoostinHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const temporary = `${databasePath}.restore`;
  try {
    writeFileSync(temporary, plaintext, { mode: 0o600, flag: "wx" });
    const restored = new Database(temporary, { readonly: true });
    try {
      const result = restored.pragma("integrity_check", { simple: true });
      if (result !== "ok") throw new Error("Restored database failed integrity check");
    } finally {
      restored.close();
    }
    renameSync(temporary, databasePath);
    chmodSync(databasePath, 0o600);
    return { database: databasePath };
  } finally {
    plaintext.fill(0);
    rmSync(temporary, { force: true });
  }
}
