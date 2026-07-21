import { createWriteStream } from "node:fs";

import yazl from "yazl";

export async function createZip(
  path: string,
  entries: Record<string, string>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const output = createWriteStream(path, { mode: 0o600 });
    output.on("close", resolve);
    output.on("error", reject);
    zip.outputStream.on("error", reject).pipe(output);
    for (const [name, content] of Object.entries(entries)) {
      zip.addBuffer(Buffer.from(content), name);
    }
    zip.end();
  });
}
