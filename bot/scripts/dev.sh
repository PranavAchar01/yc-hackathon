#!/usr/bin/env bash
# pnpm dev: read secrets from Keychain, then run the bot in the foreground.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=/dev/null
source scripts/secrets.sh
missing=()
for name in SLACK_BOT_TOKEN SLACK_APP_TOKEN ANTHROPIC_API_KEY; do
  [[ -n "${!name:-}" ]] || missing+=("$name")
done
if ((${#missing[@]})); then
  echo "Missing in Keychain: ${missing[*]}" >&2
  echo "Add each with: security add-generic-password -a \"\$USER\" -s NAME -w" >&2
  [[ " ${missing[*]} " == *" SLACK_"* ]] && exit 1
fi
exec node --import tsx src/index.ts
