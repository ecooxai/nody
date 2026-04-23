#!/usr/bin/env bash
set -euo pipefail

RUN_CHECKS=0
RUN_WORKER=1
WORKER_MODE="auto"
WORKER_URL="http://[::1]:8787/v1/health"
WORKER_BINDINGS_MODE="${NODY_DEV_WORKER_BINDINGS_MODE:-local}"
ENV_FILE="${NODY_DEV_ENV_FILE:-.env.dev}"
PROJECT_LOCK_ID="$(pwd | sha256sum | awk '{print $1}')"
LOCK_DIR="${TMPDIR:-/tmp}/nody-dev-${PROJECT_LOCK_ID}.lock"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
  set +a
else
  echo "No ${ENV_FILE} found; using built-in local development defaults." >&2
fi

if [[ -z "${WORKER_API_BASE_URL:-}" || "${WORKER_API_BASE_URL}" == "http://127.0.0.1:8787/v1" || "${WORKER_API_BASE_URL}" == "http://localhost:8787/v1" ]]; then
  export WORKER_API_BASE_URL="http://[::1]:8787/v1"
fi

if [[ "${WORKER_BINDINGS_MODE}" == "remote" ]]; then
  export WORKER_API_BASE_URL="http://[::1]:8787/v1"
fi

if [[ "${WORKER_BINDINGS_MODE}" != "local" && "${WORKER_BINDINGS_MODE}" != "remote" ]]; then
  echo "Invalid NODY_DEV_WORKER_BINDINGS_MODE=${WORKER_BINDINGS_MODE}; expected local or remote." >&2
  exit 1
fi

usage() {
  cat <<'EOF'
Usage: ./dev.sh [--check] [--worker] [--remote-bindings] [--no-worker] [--full] [--help]

Defaults to local dev mode:
  - loads .env.dev when present
  - starts the Next.js dev server
  - starts the local Cloudflare worker when WORKER_API_BASE_URL points to a local loopback address
  - skips the typecheck/test gate

Options:
  --check   Run ./test.sh before starting the dev server
  --worker  Start the Cloudflare worker alongside Next.js
  --remote-bindings
            Run the dev Worker on Cloudflare with remote D1/R2 bindings
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
    --remote-bindings)
      RUN_WORKER=1
      WORKER_MODE="force-on"
      WORKER_BINDINGS_MODE="remote"
      export WORKER_API_BASE_URL="http://[::1]:8787/v1"
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
  if [[ "${WORKER_API_BASE_URL}" != "http://[::1]:8787/v1" ]]; then
    RUN_WORKER=0
  fi
fi

if [[ ! -x ./node_modules/.bin/next || ! -x ./node_modules/.bin/wrangler ]]; then
  echo "Missing local binaries in ./node_modules/.bin. Run npm install first." >&2
  exit 1
fi

WORKER_PID=""
NEXT_PID=""

if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
  LOCK_PID=""
  if [[ -f "${LOCK_DIR}/pid" ]]; then
    LOCK_PID="$(cat "${LOCK_DIR}/pid" 2>/dev/null || true)"
  fi

  if [[ -n "${LOCK_PID}" ]] && kill -0 "${LOCK_PID}" 2>/dev/null; then
    echo "A dev server for this project is already running with PID ${LOCK_PID}." >&2
    exit 1
  fi

  rm -rf "${LOCK_DIR}"
  if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
    echo "Could not acquire dev server lock at ${LOCK_DIR}." >&2
    exit 1
  fi
fi
printf '%s\n' "$$" > "${LOCK_DIR}/pid"

cleanup() {
  if [[ -n "${NEXT_PID}" ]]; then
    kill "${NEXT_PID}" 2>/dev/null || true
    wait "${NEXT_PID}" 2>/dev/null || true
  fi
  if [[ -n "${WORKER_PID}" ]]; then
    kill "${WORKER_PID}" 2>/dev/null || true
    wait "${WORKER_PID}" 2>/dev/null || true
  fi
  rm -rf "${LOCK_DIR}"
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM

if (( RUN_CHECKS )); then
  ./test.sh
fi

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
  if [[ "${WORKER_BINDINGS_MODE}" == "remote" ]]; then
    echo "Applying remote D1 migrations for cloud-backed dev mode." >&2
    CI=1 ./node_modules/.bin/wrangler d1 migrations apply nody-db --remote --config worker/wrangler.jsonc
    echo "Starting Worker with remote Cloudflare D1/R2 bindings." >&2
    ./node_modules/.bin/wrangler dev --remote --config worker/wrangler.jsonc --port 8787 --ip :: &
  else
    ./node_modules/.bin/wrangler d1 migrations apply nody-db --local --config worker/wrangler.jsonc
    ./node_modules/.bin/wrangler dev --config worker/wrangler.jsonc --port 8787 --ip :: &
  fi
  WORKER_PID=$!
  wait_for_worker
fi

rm -rf .next
NEXT_STATUS=0
./node_modules/.bin/next dev --disable-source-maps --hostname :: &
NEXT_PID=$!
wait "${NEXT_PID}" || NEXT_STATUS=$?
NEXT_PID=""
exit "${NEXT_STATUS}"
