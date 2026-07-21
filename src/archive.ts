import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";

import yauzl, { type Entry, type ZipFile } from "yauzl";

const MAX_ZIP_BYTES = 500 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_ENTRY_BYTES = 100 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 100;

export interface ReadArchiveResult {
  checksum: string;
  entries: Map<string, Buffer>;
  fingerprint: string;
}

function validateEntry(entry: Entry): void {
  const name = entry.fileName;
  const parts = name.split("/");
  if (
    name.includes("\\") ||
    name.includes("\0") ||
    isAbsolute(name) ||
    parts.includes("..") ||
    name !== name.normalize("NFC")
  ) {
    throw new Error(`Unsafe archive entry: ${JSON.stringify(name)}`);
  }
  const unixMode = (entry.externalFileAttributes >>> 16) & 0o170000;
  if (unixMode === 0o120000) {
    throw new Error(`Symbolic links are not allowed: ${name}`);
  }
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
    throw new Error(`Archive entry exceeds 100 MB: ${name}`);
  }
  const ratio =
    entry.compressedSize === 0
      ? entry.uncompressedSize === 0
        ? 1
        : Number.POSITIVE_INFINITY
      : entry.uncompressedSize / entry.compressedSize;
  if (ratio > MAX_COMPRESSION_RATIO) {
    throw new Error(`Archive entry exceeds compression ratio limit: ${name}`);
  }
}

async function hashFile(path: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function openZip(path: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      path,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, zip) => {
        if (error || !zip) reject(error ?? new Error("Unable to open archive"));
        else resolve(zip);
      },
    );
  });
}

function readEntry(zip: ZipFile, entry: Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error(`Unable to read ${entry.fileName}`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_ENTRY_BYTES) stream.destroy(new Error("Entry too large"));
        else chunks.push(chunk);
      });
      stream.on("error", reject);
      stream.on("end", () => resolve(Buffer.concat(chunks)));
    });
  });
}

export async function readAllowedArchive(
  path: string,
  allowedNames: ReadonlySet<string>,
): Promise<ReadArchiveResult> {
  const size = statSync(path).size;
  if (size > MAX_ZIP_BYTES) throw new Error("Archive exceeds 500 MB");
  const checksum = await hashFile(path);
  const zip = await openZip(path);
  const entries = new Map<string, Buffer>();
  const structure: string[] = [];
  let total = 0;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(error);
    };
    zip.on("error", fail);
    zip.on("end", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    zip.on("entry", (entry) => {
      void (async () => {
        try {
          validateEntry(entry);
          total += entry.uncompressedSize;
          if (total > MAX_TOTAL_BYTES) throw new Error("Archive exceeds 1 GB");
          structure.push(
            `${entry.fileName}:${entry.uncompressedSize}:${entry.crc32}`,
          );
          const name = basename(entry.fileName);
          if (allowedNames.has(name) && !entry.fileName.endsWith("/")) {
            if (entries.has(name)) throw new Error(`Duplicate archive entry: ${name}`);
            entries.set(name, await readEntry(zip, entry));
          }
          zip.readEntry();
        } catch (error) {
          fail(error);
        }
      })();
    });
    zip.readEntry();
  });

  return {
    checksum,
    entries,
    fingerprint: createHash("sha256")
      .update(structure.sort().join("\n"))
      .digest("hex"),
  };
}
