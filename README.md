# Boostin

Boostin is an offline, local-first CLI for learning from your own professional
posts and first-party analytics exports.

It does not scrape LinkedIn, control a browser, publish posts, send messages,
automate comments, or build a contact graph. Human judgment and the platform's
native interface stay in the write path.

> Boostin is independent software and is not affiliated with, endorsed by, or
> sponsored by LinkedIn Corporation.

## Status

Boostin is pre-release software. Its import formats may need updates when a
platform changes its export files. Never attach a real archive, analytics file,
database, or private report to a public issue.

## Requirements

- macOS with FileVault enabled for real data
- Node.js 22 or newer
- pnpm

## Development

```sh
pnpm install
pnpm validate
```

Only synthetic fixtures belong in this repository.

`main` is production. See [CONTRIBUTING.md](CONTRIBUTING.md) for the branch
workflow.

## Quick start

Real imports are intentionally blocked until FileVault is enabled:

```sh
pnpm build
node dist/cli.js doctor
node dist/cli.js init
node dist/cli.js import posts ~/Downloads/linkedin-export.zip
node dist/cli.js import analytics ~/Downloads/analytics.xlsx \
  --captured-at 2026-07-21T12:00:00.000Z
node dist/cli.js report weekly --private --week 2026-07-20
```

LinkedIn archive formats drift. Boostin currently recognizes both the legacy
`Shares.csv` export and the July 2026 `Shares_<member-id>.csv` export. A post
that is newer than the latest account archive can be registered from a local
Markdown file and will be reconciled by URL during a later archive import:

```sh
node dist/cli.js post add \
  --url https://www.linkedin.com/posts/example \
  --published-at 2026-07-22T12:00:00-03:00 \
  --body-file ./post.md \
  --source manual
```

Public reports require explicit confirmation and contain aggregate allowlisted
fields only:

```sh
node dist/cli.js report weekly --public --confirm-public --week 2026-07-20
```

## Professional graph

Boostin can generate a private professional-content corpus and invoke Graphify
through a local Ollama model. The corpus, raw graph, report, and interactive
HTML remain under Boostin's private application-support directory.

```sh
uv tool install "graphifyy[ollama]"
ollama pull llama3.2:latest
node dist/cli.js graph build \
  --corpus professional \
  --source ./public-project-summary.md
node dist/cli.js graph status --json
```

Boostin creates a local `boostin-graphify:latest` Ollama profile from the
already-installed `llama3.2:latest` weights. The profile adds an 8K context and
a hard 2,048-token prediction cap so Graphify receives bounded JSON instead of
an unbounded continuation. This reuses the existing model layers and performs
no additional model download.

Additional source files must be explicit Markdown, MDX, or text files. Boostin
never scans Downloads, repositories, messages, connections, or browser data.

A raw local-model extraction is evidence, not a finished narrative. Small local
models can leave singleton nodes, duplicate labels, or literal placeholder
labels. Preserve that raw output, then create a separate connected view from a
review file:

```sh
node dist/cli.js graph curate \
  --run latest \
  --review ~/Library/Application\ Support/Boostin/curated-graph-review.json
```

The review uses the same node and edge shape as the public allowlist. Every
curated node must map to a real private node. Relationships absent from the raw
graph require `approvedInference: true`; ambiguous raw relationships are
rejected. Boostin also rejects placeholder labels, duplicate source mappings,
disconnected components, and isolated nodes. The raw Graphify output is never
overwritten.

A public graph is a separate allowlisted product. It requires a reviewed JSON
allowlist whose nodes map to the private graph. Extracted edges are accepted;
inferred edges require `approvedInference: true`; ambiguous edges are rejected.
The exported manifest contains no private node IDs, source prose, URLs, profile
identifiers, or local paths.

```sh
node dist/cli.js graph export-public \
  --run latest \
  --allowlist ~/Library/Application\ Support/Boostin/public-graph-allowlist.json \
  --out ./public-graph
```

## Campaign checkpoints

Campaigns schedule measurement checkpoints without logging into a social
network or automating engagement:

```sh
node dist/cli.js campaign start \
  --slug linkedin-career-graph \
  --article-url https://appheat.co/posts/linkedin-career-graph/ \
  --post-url https://www.linkedin.com/posts/example \
  --published-at 2026-07-23T12:00:00-03:00

node dist/cli.js due --json
node dist/cli.js reminders install
```

The four checkpoints are 24 hours, 72 hours, 7 days, and 30 days after
publication. Place an official archive or analytics workbook only in
`~/Library/Application Support/Boostin/inbox/`, then process it explicitly:

```sh
node dist/cli.js inbox process \
  --captured-at 2026-07-24T12:00:00-03:00
node dist/cli.js checkpoint complete \
  --campaign linkedin-career-graph \
  --name 24h \
  --captured-at 2026-07-24T12:00:00-03:00
node dist/cli.js report campaign \
  --slug linkedin-career-graph \
  --private
```

`boostin due --json` is the stable read-only interface for Firstmate or another
local supervisor. Boostin remains the only owner of the schedule.

Create a portable authenticated backup without putting the passphrase in shell
history:

```sh
read -s BOOSTIN_BACKUP_PASSPHRASE
printf '%s\n' "$BOOSTIN_BACKUP_PASSPHRASE" | \
  node dist/cli.js backup create ~/Documents/boostin.boostin-backup --passphrase-stdin
unset BOOSTIN_BACKUP_PASSPHRASE
```

See [the threat model](docs/threat-model.md),
[data-minimization contract](docs/data-minimization.md), and
[acceptable-use policy](docs/acceptable-use.md) before using real data.

## Support boundary

Export formats are unofficial and may change without notice. Boostin fails
closed on unrecognized structures. Use `boostin doctor --fingerprint <file>` to
produce a value-free diagnostic for a bug report. Never share the original
file.
