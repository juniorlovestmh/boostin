# Threat Model

## Assets

- Unpublished drafts
- A user's own post history and aggregate analytics
- Self-reported professional outcomes
- Portable database backups
- Private Graphify corpora, raw graphs, reports, and interactive HTML
- Campaign URLs, schedules, checkpoints, and private reports

## Defended against

- Accidental Git commits and public issue attachments
- Offline theft of a FileVault-protected Mac
- Accidental disclosure through public reports
- Malformed, oversized, traversal, and decompression attacks in imports
- Loss of the original Mac when an independently encrypted backup exists

## Not defended against

- Malware or another process running as the same logged-in user
- An agent or editor explicitly granted access to the database directory
- Screen capture, clipboard history, crash dumps, or compromised dependencies
- Weak, reused, disclosed, or forgotten backup passphrases

Core commands make no network calls and emit no telemetry. The database lives
outside project workspaces and uses mode 0600. Import, snapshot, draft, and
outcome commands fail closed while FileVault is unavailable.

Graph generation is the one explicit local-service integration. Boostin invokes
Graphify with the Ollama backend over the local machine only. It does not accept
cloud API keys for this flow. Public graph export starts from an allowlist and
does not redact a private graph after the fact.

The optional launchd reminder runs `boostin reminders notify` once per hour. It
shows only the campaign slug and checkpoint name. It does not open LinkedIn,
download files, publish content, or send engagement.
