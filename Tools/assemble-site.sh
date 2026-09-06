#!/usr/bin/env bash
#
# Assemble the static site into _site/ for a host that serves a directory
# (Vercel, Netlify, GitHub Pages).
#
# It excludes rather than allowlists. An allowlist was tried once and broke the
# app: Simulator/index.html loads the Lens runtime stub from Tests/, which the
# list did not include, and a missing module leaves the page on "loading
# furniture…" for ever. Excluding keeps whatever the pages reference.
#
# The copy uses tar rather than rsync: rsync is not on every build image, and a
# missing binary here fails the deploy after everything else has succeeded.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/_site}"

rm -rf "$OUT"
mkdir -p "$OUT"

tar -cf - -C "$ROOT" \
  --exclude='./.git' \
  --exclude='./.github' \
  --exclude='./.claude' \
  --exclude='./node_modules' \
  --exclude='./LensProject' \
  --exclude='./_site' \
  --exclude='./.vercel' \
  --exclude='./__pycache__' \
  --exclude='*.pyc' \
  . | tar -xf - -C "$OUT"

missing=0
for f in Simulator/build/build-id.js Tests/lens-runtime-stub.js index.html Simulator/index.html; do
  if [ ! -f "$OUT/$f" ]; then echo "assemble-site: missing $f" >&2; missing=1; fi
done
if [ "$missing" -ne 0 ]; then
  echo "assemble-site: incomplete output - did 'npm run build:web' run first?" >&2
  exit 1
fi

echo "assemble-site: $(find "$OUT" -type f | wc -l | tr -d ' ') files, $(du -sh "$OUT" | cut -f1)"
