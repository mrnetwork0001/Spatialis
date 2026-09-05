#!/usr/bin/env sh
# Copy the canonical Scripts/*.ts and Assets/Prefabs/*.glb into the Lens Studio
# project's Assets/ folder, where the editor imports them. Scripts/ stays the
# single source of truth; the project holds an import copy plus the .meta
# sidecars only Lens Studio can generate. `--check` fails if the copy has drifted.
set -e
cd "$(dirname "$0")/.."
P=LensProject/Assets
if [ "$1" = "--check" ]; then
  diff -rq Scripts "$P/Scripts" -x '*.meta' && diff -rq Assets/Prefabs "$P/Prefabs" -x '*.meta' -x m -x .gitkeep \
    && echo "sync:lens — project copy matches Scripts/ and Assets/Prefabs/" || { echo "sync:lens — DRIFT: run npm run sync:lens"; exit 1; }
  exit 0
fi
mkdir -p "$P/Scripts" "$P/Prefabs"
cp Scripts/*.ts "$P/Scripts/"
cp Assets/Prefabs/*.glb "$P/Prefabs/"
echo "sync:lens — copied $(ls Scripts/*.ts | wc -l | tr -d ' ') scripts and $(ls Assets/Prefabs/*.glb | wc -l | tr -d ' ') models into $P"
