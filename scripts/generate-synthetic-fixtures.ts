import { chmodSync, createWriteStream, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import yazl from "yazl";

const outputIndex = process.argv.indexOf("--out");
const outputArgument = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
if (!outputArgument) {
  throw new Error("Usage: pnpm fixtures:generate -- --out <directory>");
}
const output = resolve(outputArgument);
mkdirSync(output, { recursive: true, mode: 0o700 });

const fixtureDate = new Date("2026-01-01T00:00:00.000Z");
const profileUrl = "https://social.example/profiles/synthetic-user";
const postUrl = "https://social.example/posts/synthetic-1";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function worksheet(rows: string[][]): string {
  const body = rows
    .map((row, rowIndex) => {
      const cells = row
        .map(
          (value, columnIndex) =>
            `<c r="${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`,
        )
        .join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");
  return `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

async function writeZip(path: string, entries: Record<string, string>): Promise<void> {
  await new Promise<void>((resolveWrite, reject) => {
    const zip = new yazl.ZipFile();
    const file = createWriteStream(path, { mode: 0o600 });
    file.on("close", resolveWrite);
    file.on("error", reject);
    zip.outputStream.on("error", reject).pipe(file);
    for (const [name, contents] of Object.entries(entries)) {
      zip.addBuffer(Buffer.from(contents), name, { mtime: fixtureDate, mode: 0o100600 });
    }
    zip.end();
  });
  chmodSync(path, 0o600);
}

const postsPath = join(output, "synthetic-posts.zip");
await writeZip(postsPath, {
  "Profile.csv":
    `First Name,Last Name,Public Profile URL\nSynthetic,User,${profileUrl}\n`,
  "Shares.csv":
    `Date,ShareLink,ShareCommentary,Visibility\n2026-01-15 12:00:00,${postUrl},Synthetic example for offline import testing.,PUBLIC\n`,
});

const analyticsPath = join(output, "synthetic-analytics.xlsx");
await writeZip(analyticsPath, {
  "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
  "_rels/.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  "xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Content" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  "xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
  "xl/worksheets/sheet1.xml": worksheet([
    [
      "Post URL",
      "Impressions",
      "Members reached",
      "Reactions",
      "Comments",
      "Reposts",
      "Saves",
      "Sends",
      "Out-of-network %",
    ],
    [postUrl, "120", "84", "7", "2", "1", "3", "0", "18"],
  ]),
});

process.stdout.write(
  `Generated synthetic-posts.zip and synthetic-analytics.xlsx in ${output}.\n`,
);
