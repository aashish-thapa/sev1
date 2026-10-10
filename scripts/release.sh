#!/usr/bin/env bash
# Deploys exactly the committed HEAD — never uncommitted work in the tree — by building in a throwaway worktree.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
work="$(mktemp -d)"
trap 'git -C "$root" worktree remove --force "$work" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
git -C "$root" worktree add --quiet --detach "$work" HEAD
ln -s "$root/node_modules" "$work/node_modules"
cd "$work"
echo "Releasing $(git log --oneline -1)"
node scripts/validate-packs.ts
./node_modules/.bin/tsc -b
./node_modules/.bin/vitest run
./node_modules/.bin/vite build
./node_modules/.bin/wrangler deploy
