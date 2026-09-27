#!/usr/bin/env bash
# One-time sign-in for the Cua sandbox browser. Opens Firefox inside the sandbox (persistent profile in
# bot/.sandbox/storage, survives restarts) on the given site, then opens the live desktop view on this Mac
# so you can sign in by hand. The agent never types passwords or 2FA codes.
#   pnpm sandbox:login https://github.com/login
#   pnpm sandbox:login https://mail.google.com
set -euo pipefail
cd "$(dirname "$0")/.."
url="${1:-https://github.com/login}"
live="${CUA_LIVE_URL:-http://localhost:6901}"
export CUA_STORAGE="$PWD/.sandbox/storage"
mkdir -p "$CUA_STORAGE"
uv run --quiet --python 3.12 cua/runner.py warm "$url"
echo "Sign in by hand in the sandbox desktop: $live"
open "$live"
