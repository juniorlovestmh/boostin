# ADR-0003: Dagster owns derived private graph data

Status: accepted

## Decision

Boostin uses a contained Python 3.13 and Dagster subsystem for Bronze, Silver,
and Gold professional-graph processing. The TypeScript application remains the
only owner of imports, campaigns, the source `boostin.db`, Graphify execution,
curation, and public export.

Python opens the source database read-only and stores derived graph tables in a
separate private SQLite database beneath Boostin's application-support
directory. Bronze preserves immutable raw nodes, edges, checksums, and
private-relative evidence references. Silver retains every Bronze node as
resolved, merged, quarantined, or rejected. Gold contains only traced,
connected analytical data that passes Dagster checks.

Silver may call Ollama over HTTP loopback for local embeddings. It must reject
non-loopback endpoints. Dagster metadata contains aggregate counts, checksums,
and model names, never source prose, account identifiers, credentials, or
absolute private paths.

dbt is deferred. Version one is dominated by graph validation, entity
resolution, embeddings, evidence lineage, and review boundaries rather than
SQL-centric models.

## Consequences

The pipeline can be stopped or its derived directory moved aside without
altering source imports or immutable Graphify runs. Uncertain records remain
available for review instead of disappearing into a polished graph.

Dagster provides local asset lineage, checks, run history, and failure
visibility without becoming a second importer or publishing surface. Public
artifacts still require the separate human-reviewed allowlist defined by
ADR-0002.
