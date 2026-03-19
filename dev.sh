#!/usr/bin/env bash
set -euo pipefail

RUN_CHECKS=0
RUN_WORKER=0

usage() {
  cat <<'EOF'
Usage: ./dev.sh [--check] [--worker] [--full] [--help]

Defaults to the lowest-RAM dev mode:
  - starts only the Next.js dev server
  - skips the typecheck/test gate

Options:
  --check   Run ./test.sh before starting the dev server
  --worker  Start the Cloudflare worker alongside Next.js
  --full    Equivalent to --check --worker
  --help    Show this help
EOF
}

while (($#)); do
  case "$1" in
    --check)
      RUN_CHECKS=1
      ;;
    --worker)
      RUN_WORKER=1
      ;;
    --full)
      RUN_CHECKS=1
      RUN_WORKER=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

if [[ ! -x ./node_modules/.bin/next || ! -x ./node_modules/.bin/wrangler ]]; then
  echo "Missing local binaries in ./node_modules/.bin. Run npm install first." >&2
  exit 1
fi

if (( RUN_CHECKS )); then
  ./test.sh
fi

WORKER_PID=""
cleanup() {
  if [[ -n "${WORKER_PID}" ]]; then
    kill "${WORKER_PID}" 2>/dev/null || true
    wait "${WORKER_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if (( RUN_WORKER )); then
  ./node_modules/.bin/wrangler dev --config worker/wrangler.jsonc --port 8787 &
  WORKER_PID=$!
fi

exec ./node_modules/.bin/next dev --disable-source-maps
