#!/usr/bin/env sh
# Starts the Vite React app (offer_wale_baba)
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
FRONTEND="$SCRIPT_DIR/../../frontend/offer_wale_baba"
if [ ! -f "$FRONTEND/package.json" ]; then
  echo "ERROR: Could not find frontend at: $FRONTEND" >&2
  exit 1
fi
cd "$FRONTEND" || exit 1
echo "Starting Vite dev server in: $PWD"
npm run dev
