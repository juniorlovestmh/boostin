# Boostin pipeline runtime

Boostin's Dagster project is a contained, local-only data subsystem for the
private professional graph:

```text
completed Graphify run
  -> Bronze immutable nodes, edges, checksums, and evidence references
  -> Silver normalized entities, lineage, candidates, and quarantine
  -> Gold connected analytical graph and evidence-backed insight data
```

The TypeScript application remains the only owner of imports and
`$BOOSTIN_HOME/boostin.db`. The pipeline opens that database read-only and
writes derived tables to
`$BOOSTIN_HOME/pipeline/boostin-pipeline.db`. It does not publish, scrape,
enable telemetry, or call a cloud service.

## Commands

```sh
pnpm pipeline:check
pnpm pipeline:test
pnpm pipeline:materialize
pnpm pipeline:dev
```

`pipeline:materialize` processes the latest completed Graphify run by default.
Set `BOOSTIN_PIPELINE_MODE=rebuild` to invoke Boostin's existing local Graphify
build first, or set `BOOSTIN_PIPELINE_RAW_RUN` to a completed run UUID to
reproduce a historical materialization. Silver placeholder resolution uses the local
Ollama model `nomic-embed-text:latest`; override only the local model name with
`BOOSTIN_PIPELINE_EMBEDDING_MODEL`.

Automatic resolution is conservative: similarity must be at least `0.55` and
the winning candidate must lead by at least `0.02`. Records below either
threshold remain in `silver_nodes` with status `quarantined`. They do not enter
Gold and are never silently dropped.

The first run writes a private `review-decisions.json` template beside the
derived database. A human may add `merge`, `resolve`, or `reject` decisions and
materialize again. The file is checksum-bound to its raw graph so decisions
cannot silently apply to a different source run.

Dagster binds only to `127.0.0.1:3001`, and telemetry is disabled. Metadata
contains counts, checksums, model names, and private-relative references rather
than source prose, profile identifiers, or absolute paths.

## Runtime storage

The launcher keeps its shared uv download cache at
`/Volumes/CodeSSD/codex/uv-cache` and creates one environment per checkout
under `/Volumes/CodeSSD/codex/boostin-pipeline-envs/`. The checkout path, rather
than the lockfile, names the environment so `uv run --locked` updates it in
place when dependencies change.

When CodeSSD is unavailable, the runner refuses to continue unless
`BOOSTIN_ALLOW_MAIN_SSD_PIPELINE_ENV=1` is set. That explicit fallback stores
both the cache and environment under
`$BOOSTIN_HOME/pipeline/runtime/` (or Boostin's Application Support directory),
never inside the checkout.

Dagster run history and derived data are private local state. Recovery is to
stop the UI and move `$BOOSTIN_HOME/pipeline/` aside. The source database and
immutable Graphify runs are unaffected.

## Legacy runtime cleanup

Earlier development versions created lockfile-keyed directories directly under
`/Volumes/CodeSSD/codex`. Boostin owns directories whose basename exactly
matches `uv-cache-<64 hex characters>` or
`boostin-pipeline-<64 hex characters>`. List those legacy candidates without
changing them:

```sh
find /Volumes/CodeSSD/codex -maxdepth 1 -type d -print |
  awk -F/ '$NF ~ /^(uv-cache|boostin-pipeline)-[0-9a-f]{64}$/'
```

Cleanup is deliberately not automatic because another checkout or process may
still use a legacy environment. For each exact candidate, first verify that
`lsof +D '/Volumes/CodeSSD/codex/<candidate>'` reports no users. Then remove
only that fully spelled-out candidate.
