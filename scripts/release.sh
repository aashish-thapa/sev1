#!/usr/bin/env bash
# Deploys exactly the committed HEAD — never uncommitted work in the tree — by building in a throwaway worktree.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"

# Production follows main. Releasing a feature branch is how the live site silently falls behind
# main, so doing it has to be said out loud rather than happening by accident.
if [ "${RELEASE_FROM_ANY_BRANCH:-}" != 1 ]; then
  branch="$(git -C "$root" rev-parse --abbrev-ref HEAD)"
  if [ "$branch" != main ]; then
    echo "release: HEAD is '$branch', not main. Set RELEASE_FROM_ANY_BRANCH=1 to release it anyway." >&2
    exit 1
  fi
  git -C "$root" fetch --quiet origin main
  local_head="$(git -C "$root" rev-parse HEAD)"
  remote_head="$(git -C "$root" rev-parse origin/main)"
  if [ "$local_head" != "$remote_head" ]; then
    echo "release: main is at ${local_head:0:7} but origin/main is at ${remote_head:0:7}; push or pull first." >&2
    exit 1
  fi
fi

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
