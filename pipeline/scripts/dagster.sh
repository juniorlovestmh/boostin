#!/bin/sh
set -eu
umask 077

action="${1:-}"
pipeline_root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"

case "$action" in
  check|dev|materialize|test) ;;
  *)
    printf '%s\n' "Usage: $0 {check|dev|materialize|test}" >&2
    exit 2
    ;;
esac

export PYTHONUTF8=1

checkout_key="$(printf '%s' "$pipeline_root" | shasum -a 256 | cut -d ' ' -f 1)"
codessd_root="${BOOSTIN_CODESSD_ROOT:-/Volumes/CodeSSD/codex}"
if [ -d "$codessd_root" ]; then
  export UV_CACHE_DIR="${BOOSTIN_UV_CACHE_DIR:-${codessd_root}/uv-cache}"
  export UV_PROJECT_ENVIRONMENT="${BOOSTIN_PIPELINE_VENV:-${codessd_root}/boostin-pipeline-envs/${checkout_key}}"
elif [ "${BOOSTIN_ALLOW_MAIN_SSD_PIPELINE_ENV:-0}" = "1" ]; then
  boostin_support_root="${BOOSTIN_HOME:-${HOME}/Library/Application Support/Boostin}"
  fallback_root="${boostin_support_root}/pipeline/runtime"
  export UV_CACHE_DIR="${BOOSTIN_UV_CACHE_DIR:-${fallback_root}/uv-cache}"
  export UV_PROJECT_ENVIRONMENT="${BOOSTIN_PIPELINE_VENV:-${fallback_root}/environments/${checkout_key}}"
else
  printf '%s\n' \
    "Boostin pipeline dependencies require ${codessd_root}. Set BOOSTIN_ALLOW_MAIN_SSD_PIPELINE_ENV=1 to explicitly allow a local fallback." >&2
  exit 1
fi

cleanup_home=""
if [ "$action" = "dev" ] || [ "$action" = "materialize" ]; then
  boostin_support_root="${BOOSTIN_HOME:-${HOME}/Library/Application Support/Boostin}"
  dagster_home="${BOOSTIN_DAGSTER_HOME:-${boostin_support_root}/pipeline/dagster}"
else
  dagster_home="$(mktemp -d "${TMPDIR:-/tmp}/boostin-dagster-${action}.XXXXXX")"
  cleanup_home="$dagster_home"
  trap 'rm -rf -- "$cleanup_home"' EXIT HUP INT TERM
fi

if [ -L "$dagster_home" ]; then
  printf '%s\n' "refusing symbolic link for DAGSTER_HOME: ${dagster_home}" >&2
  exit 1
fi
mkdir -p "$dagster_home"
linked_entry="$(find "$dagster_home" -type l -print -quit)"
if [ -n "$linked_entry" ]; then
  printf '%s\n' "refusing symbolic link inside DAGSTER_HOME: ${linked_entry}" >&2
  exit 1
fi
find "$dagster_home" -type d -exec chmod 700 {} \;
find "$dagster_home" -type f -exec chmod 600 {} \;
install -m 600 "$pipeline_root/config/dagster.yaml" "$dagster_home/dagster.yaml"
export DAGSTER_HOME="$dagster_home"

cd "$pipeline_root"

case "$action" in
  check)
    uv run --locked dg check defs
    printf '%s\n' "Boostin pipeline definitions are valid"
    ;;
  dev)
    exec uv run --locked dg dev --host 127.0.0.1 --port 3001
    ;;
  materialize)
    pipeline_mode="${BOOSTIN_PIPELINE_MODE:-reuse_latest}"
    case "$pipeline_mode" in
      reuse_latest) ;;
      rebuild)
        if [ -n "${BOOSTIN_PIPELINE_RAW_RUN:-}" ]; then
          printf '%s\n' \
            "BOOSTIN_PIPELINE_RAW_RUN cannot be combined with BOOSTIN_PIPELINE_MODE=rebuild" >&2
          exit 2
        fi
        (
          cd "$pipeline_root/.."
          pnpm exec tsx src/cli.ts graph build --corpus professional --json >/dev/null
        )
        ;;
      *)
        printf '%s\n' \
          "BOOSTIN_PIPELINE_MODE must be reuse_latest or rebuild" >&2
        exit 2
        ;;
    esac
    uv run --locked dg launch --assets '*'
    ;;
  test)
    uv run --locked pytest
    ;;
esac
