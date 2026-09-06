#!/usr/bin/env bash
#
# Assemble the static site into _site/ for a host that serves a directory
# (Vercel, Netlify, GitHub Pages).
#
# It excludes rather than allowlists. An allowlist was tried once and broke the
# app: Simulator/index.html loads the Lens runtime stub from Tests/, which the
# list did not include, and a missing module leaves the page on "loading
# furniture…" for ever. Excluding keeps whatever the pages reference.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/_site}"

rm -rf "$OUT"
mkdir -p "$OUT"

rsync -a \
  --exclude '.git' \
  --exclude '.github' \
  --exclude 'node_modules' \
  --exclude 'LensProject' \
  --exclude '_site' \
  --exclude '.vercel' \
  --exclude '*.pyc' \
  --exclude '__pycache__' \
  "$ROOT/" "$OUT/"

# The two files without which the app silently does nothing.
test -f "$OUT/Simulator/build/build-id.js" || { echo "assemble-site: the web bundle is missing - run npm run build:web first" >&2; exit 1; }
test -f "$OUT/Tests/lens-runtime-stub.js" || { echo "assemble-site: the Lens runtime stub is missing" >&2; exit 1; }

echo "assemble-site: $(du -sh "$OUT" | cut -f1) in $OUT"
