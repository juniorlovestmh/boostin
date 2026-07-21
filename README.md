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

### Branch model

- `main` is production.
- `staging` is the integration branch and source for release pull requests.
- `dev/*` branches are short-lived work branches created from and merged back
  into `staging`.

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

Public reports require explicit confirmation and contain aggregate allowlisted
fields only:

```sh
node dist/cli.js report weekly --public --confirm-public --week 2026-07-20
```

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
