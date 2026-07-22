import { createWriteStream, readFileSync, writeFileSync } from "node:fs";

import yazl from "yazl";

export async function createZip(
  path: string,
  entries: Record<string, string>,
  options: Record<string, { compress?: boolean; mode?: number }> = {},
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const output = createWriteStream(path, { mode: 0o600 });
    output.on("close", resolve);
    output.on("error", reject);
    zip.outputStream.on("error", reject).pipe(output);
    for (const [name, content] of Object.entries(entries)) {
      zip.addBuffer(Buffer.from(content), name, options[name]);
    }
    zip.end();
  });
}

export function replaceZipEntryName(
  path: string,
  originalName: string,
  replacementName: string,
): void {
  const original = Buffer.from(originalName);
  const replacement = Buffer.from(replacementName);
  if (original.length !== replacement.length) {
    throw new Error("ZIP entry name replacements must have equal byte lengths");
  }
  const archive = readFileSync(path);
  let replacements = 0;
  for (let offset = archive.indexOf(original); offset >= 0; offset = archive.indexOf(original, offset + 1)) {
    replacement.copy(archive, offset);
    replacements += 1;
  }
  if (replacements !== 2) {
    throw new Error(`Expected ZIP entry name twice, found ${replacements}`);
  }
  writeFileSync(path, archive, { mode: 0o600 });
}

export function setZipEntrySizes(
  path: string,
  sizes: ReadonlyMap<string, { compressed: number; uncompressed: number }>,
): void {
  const archive = readFileSync(path);
  const patched = new Set<string>();
  for (let offset = 0; offset <= archive.length - 4; offset += 1) {
    const signature = archive.readUInt32LE(offset);
    const local = signature === 0x04034b50;
    const central = signature === 0x02014b50;
    if (!local && !central) continue;
    const nameLength = archive.readUInt16LE(offset + (local ? 26 : 28));
    const nameOffset = offset + (local ? 30 : 46);
    const name = archive.toString("utf8", nameOffset, nameOffset + nameLength);
    const size = sizes.get(name);
    if (!size) continue;
    archive.writeUInt32LE(size.compressed, offset + (local ? 18 : 20));
    archive.writeUInt32LE(size.uncompressed, offset + (local ? 22 : 24));
    if (central) patched.add(name);
  }
  if (patched.size !== sizes.size) {
    throw new Error(`Patched ${patched.size} of ${sizes.size} ZIP entries`);
  }
  writeFileSync(path, archive, { mode: 0o600 });
}
