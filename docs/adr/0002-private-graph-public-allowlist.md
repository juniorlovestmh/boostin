# ADR-0002: Private graph, public allowlist

Status: accepted

## Decision

Boostin may transform the local user's own posts and explicitly selected
public-safe files into a private Markdown corpus, then invoke Graphify through a
local Ollama model. The corpus and all Graphify outputs remain in Boostin's
private application-support directory.

Publishing is a separate operation. A public graph must be generated from a
human-reviewed allowlist that maps approved private nodes to new public IDs and
labels. Extracted relationships are eligible. Inferred relationships require
an explicit approval marker. Ambiguous relationships are rejected.

Campaign reminders are local scheduling aids. Boostin owns the schedule and
exposes it through `boostin due --json`; supervisors may read that interface but
must not maintain a second schedule.

## Consequences

The private graph can remain useful and detailed without becoming an accidental
publishing surface. Public artifacts are smaller, explainable, and auditable.
The user must review a mapping before export, and graph construction requires a
local Ollama installation and model.

Boostin still performs no social-network access, scraping, browser control,
publishing, messaging, or engagement automation.
