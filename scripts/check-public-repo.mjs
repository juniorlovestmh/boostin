/* global process */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const tracked = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], {
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .filter(Boolean);

const forbiddenPath = /(?:^|\/)(?:.*(?:linkedin|analytics).*(?:\.zip|\.xlsx)|.*\.(?:db|sqlite|boostin-backup)|.*private-report.*)$/i;
const violations = tracked.filter((path) => forbiddenPath.test(path));

for (const path of tracked) {
  if (/\.(?:png|jpe?g|gif|webp|woff2?|lock)$/i.test(path)) continue;
  const text = readFileSync(path, "utf8");
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) violations.push(path);
}

if (violations.length > 0) {
  process.stderr.write(`Public-repository safety check failed:\n${[...new Set(violations)].join("\n")}\n`);
  process.exit(1);
}
