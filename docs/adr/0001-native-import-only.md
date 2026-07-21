# ADR-0001: Native import only

Status: accepted

## Decision

Boostin accepts user-downloaded first-party exports and performs no network
access to a social platform. Humans remain in the publish and engagement path.

## Consequences

The workflow is safer and easier to audit, but formats can drift and imports
may require adapter updates. Unknown schemas fail transactionally instead of
silently producing partial metrics.
