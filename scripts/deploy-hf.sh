#!/usr/bin/env bash
# Deploys the current commit to a Hugging Face Docker Space.
# Spaces read their config from YAML front matter in README.md, which would clutter the
# GitHub README, so it is added only in a throwaway commit pushed to the Space.
# Usage: bash scripts/deploy-hf.sh [git-remote]   (default remote: hf)
set -euo pipefail

remote="${1:-hf}"
root="$(git rev-parse --show-toplevel)"
tmp="$(mktemp -d)"
cleanup() { git -C "$root" worktree remove --force "$tmp" >/dev/null 2>&1 || true; }
trap cleanup EXIT

git -C "$root" worktree add --detach "$tmp" HEAD >/dev/null
cd "$tmp"
{
  printf -- '---\n'
  printf 'title: Waste2Worth Surplus Agent\n'
  printf 'emoji: ♻️\n'
  printf 'colorFrom: green\n'
  printf 'colorTo: yellow\n'
  printf 'sdk: docker\n'
  printf 'app_port: 7860\n'
  printf 'pinned: false\n'
  printf 'license: mit\n'
  printf 'short_description: AI agent negotiates surplus deals, settles via PayPal\n'
  printf -- '---\n\n'
  cat README.md
} > README.space.md
mv README.space.md README.md
git add README.md
git commit -q -m "Hugging Face Space config for $(git -C "$root" rev-parse --short HEAD)"
git push --force "$remote" HEAD:main
echo "Pushed to $remote. The Space rebuilds in a few minutes."
