# Boostin Agent Rules

Boostin is an offline, local-first content analytics CLI. It imports only a
user's own posts and first-party analytics. It must never scrape social
networks, automate engagement, or ingest messages, contacts, connections, or
other people's content.

## Development

- Use Node 22 and pnpm.
- Create short-lived `dev/*` branches from `staging` for normal work.
- Merge `dev/*` branches into `staging` by pull request. Promote releases from
  `staging` to `main` by pull request; never commit feature work directly to
  `main` or `staging`.
- Begin behavior changes with an observable failing test through the CLI.
- Keep real exports, analytics files, databases, private reports, account
  identifiers, and credentials out of Git, issues, logs, and fixtures.
- Core commands must work without network access or telemetry.
- Run `pnpm validate` before delivery, then use the repository's no-mistakes
  pipeline.

## Campaign session start

At the beginning of Boostin content, analytics, or campaign work, run
`pnpm exec tsx src/cli.ts due --json` as a read-only check. Surface overdue
checkpoints in the handoff, but never mark one complete without the matching
first-party analytics capture. Boostin owns the schedule; do not copy it into a
second Firstmate state file.

## Agent skills

### Issue tracker

Issues and PRDs live in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. See `docs/agents/domain.md`.

## Maintaining this file

Keep durable project-intrinsic guidance here. Prefer pointers to authoritative
documents over duplicated detail, and update this file when repository-owned
commands, boundaries, or architecture change.
