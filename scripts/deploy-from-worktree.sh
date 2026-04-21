#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  cat >&2 <<'EOF'
Usage: scripts/deploy-from-worktree.sh <npm-script>

Runs the given npm script from a temporary git worktree that mirrors the
current repository state, so build artifacts stay out of the live checkout.
EOF
  exit 1
fi

TARGET_SCRIPT="$1"
ROOT_DIR="$(git rev-parse --show-toplevel)"
SOURCE_COMMIT="$(git -C "$ROOT_DIR" rev-parse HEAD)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/nody-deploy-XXXXXX")"
WORKTREE_DIR="${TMP_ROOT}/worktree"
NODE_MODULES_DIR="${ROOT_DIR}/node_modules"

cleanup() {
  if [[ -d "$WORKTREE_DIR" ]]; then
    git -C "$ROOT_DIR" worktree remove --force "$WORKTREE_DIR" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT INT TERM

if [[ ! -d "$NODE_MODULES_DIR" ]]; then
  echo "Missing ./node_modules. Run npm install first." >&2
  exit 1
fi

git -C "$ROOT_DIR" worktree add --detach "$WORKTREE_DIR" "$SOURCE_COMMIT" >/dev/null

rsync -a --delete \
  --exclude '.git' \
  --exclude '.git/' \
  --exclude '.next' \
  --exclude '.next/' \
  --exclude '.open-next' \
  --exclude '.open-next/' \
  --exclude '.wrangler' \
  --exclude '.wrangler/' \
  --exclude 'coverage' \
  --exclude 'coverage/' \
  --exclude 'node_modules' \
  --exclude 'node_modules/' \
  "$ROOT_DIR"/ "$WORKTREE_DIR"/

if ! cp -al "$NODE_MODULES_DIR" "$WORKTREE_DIR/node_modules" 2>/dev/null; then
  rm -rf "$WORKTREE_DIR/node_modules"
  cp -a "$NODE_MODULES_DIR" "$WORKTREE_DIR/node_modules"
fi

cd "$WORKTREE_DIR"
npm run "$TARGET_SCRIPT"
