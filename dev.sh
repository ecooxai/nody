#!/usr/bin/env bash
set -euo pipefail

RUN_CHECKS=0
RUN_WORKER=1
WORKER_MODE="auto"
WORKER_URL="http://127.0.0.1:8787/v1/health"
export WORKER_API_BASE_URL="${WORKER_API_BASE_URL:-http://127.0.0.1:8787/v1}"

usage() {
  cat <<'EOF'
Usage: ./dev.sh [--check] [--worker] [--no-worker] [--full] [--help]

Defaults to local dev mode:
  - starts the Next.js dev server
  - starts the local Cloudflare worker when WORKER_API_BASE_URL points to localhost
  - skips the typecheck/test gate

Options:
  --check   Run ./test.sh before starting the dev server
  --worker  Start the Cloudflare worker alongside Next.js
  --no-worker  Skip starting the local worker
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
    --no-worker)
      RUN_WORKER=0
      WORKER_MODE="force-off"
      ;;
    --full)
      RUN_CHECKS=1
      RUN_WORKER=1
      WORKER_MODE="force-on"
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

if [[ "${WORKER_MODE}" == "auto" ]]; then
  case "${WORKER_API_BASE_URL}" in
    http://127.0.0.1:8787/v1|http://localhost:8787/v1)
      ;;
    *)
      RUN_WORKER=0
      ;;
  esac
fi

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

wait_for_worker() {
  local attempts=0

  while (( attempts < 60 )); do
    if ! kill -0 "${WORKER_PID}" 2>/dev/null; then
      echo "Wrangler worker exited before becoming ready." >&2
      return 1
    fi

    if command -v curl >/dev/null 2>&1; then
      if curl --silent --fail "${WORKER_URL}" >/dev/null; then
        return 0
      fi
    else
      if node -e '
        fetch(process.argv[1])
          .then((response) => process.exit(response.ok ? 0 : 1))
          .catch(() => process.exit(1));
      ' "${WORKER_URL}"; then
        return 0
      fi
    fi

    attempts=$((attempts + 1))
    sleep 1
  done

  echo "Timed out waiting for worker health at ${WORKER_URL}." >&2
  return 1
}

if (( RUN_WORKER )); then
  ./node_modules/.bin/wrangler d1 migrations apply nody-db --local --config worker/wrangler.jsonc
  ./node_modules/.bin/wrangler dev --config worker/wrangler.jsonc --port 8787 &
  WORKER_PID=$!
  wait_for_worker
fi

exec ./node_modules/.bin/next dev --disable-source-maps
