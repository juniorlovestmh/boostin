# ADR-0002: Private graph, public allowlist

Status: accepted

## Decision

Boostin may transform the local user's own posts and explicitly selected
public-safe files into a private Markdown corpus, then invoke Graphify through a
local Ollama model. The corpus and all Graphify outputs remain in Boostin's
private application-support directory.

The raw model output remains an immutable audit artifact. A separate curated
private view may map real private nodes to reviewed labels and relationships.
That view must be connected, contain no isolated nodes, reject model
placeholders, and preserve its evidence mapping beside the generated HTML.

Publishing is a separate operation. A public graph must be generated from a
human-reviewed allowlist that maps approved private nodes to new public IDs and
labels. Extracted relationships are eligible. Inferred relationships require
an explicit approval marker. Ambiguous relationships are rejected.

Campaign reminders are local scheduling aids. Boostin owns the schedule and
exposes it through `boostin due --json`; supervisors may read that interface but
must not maintain a second schedule.

## Consequences

The raw private graph can remain honest even when model extraction is sparse.
The curated private graph provides a navigable explanation without mutating the
evidence, and public artifacts remain smaller, explainable, and auditable. The
user must review a mapping before curation or export, and graph construction
requires a local Ollama installation and model.

Boostin still performs no social-network access, scraping, browser control,
publishing, messaging, or engagement automation.
