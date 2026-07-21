import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const outputIndex = process.argv.indexOf("--out");
const outputArgument = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
if (!outputArgument) {
  throw new Error("Usage: pnpm fixtures:generate -- --out <directory>");
}
const output = resolve(outputArgument);
mkdirSync(output, { recursive: true, mode: 0o700 });
process.stdout.write(
  `Synthetic fixture destination initialized at ${output}. Use the test helpers to create scenario-specific archives.\n`,
);
