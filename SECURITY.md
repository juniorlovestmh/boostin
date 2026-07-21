# Security Policy

Report vulnerabilities privately through GitHub Security Advisories. Do not
open a public issue containing real exports, analytics, databases, reports,
credentials, profile identifiers, or screenshots of private data.

Boostin does not protect data from processes already running as the same local
user. The live database relies on FileVault plus mode-0600 permissions. Portable
backups use scrypt and AES-256-GCM, but weak or lost passphrases remain the
user's responsibility.
