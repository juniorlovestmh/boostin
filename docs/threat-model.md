# Threat Model

## Assets

- Unpublished drafts
- A user's own post history and aggregate analytics
- Self-reported professional outcomes
- Portable database backups

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
outside project workspaces and uses mode 0600. Real imports fail closed while
FileVault is unavailable.
