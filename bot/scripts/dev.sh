#!/usr/bin/env bash
export PATH="$HOME/.bun/bin:$PATH"
# pnpm dev: read secrets from Keychain, then run the bot in the foreground.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=/dev/null
source scripts/secrets.sh
missing=()
for name in SLACK_BOT_TOKEN SLACK_APP_TOKEN; do
  [[ -n "${!name:-}" ]] || missing+=("$name")
done
[[ -n "${OPENAI_API_KEY:-}${ANTHROPIC_API_KEY:-}" ]] || missing+=("OPENAI_API_KEY (or ANTHROPIC_API_KEY)")
if ((${#missing[@]})); then
  echo "Missing in Keychain: ${missing[*]}" >&2
  echo "Add each with: security add-generic-password -a \"\$USER\" -s NAME -w" >&2
  [[ " ${missing[*]} " == *" SLACK_"* ]] && exit 1
fi
exec node --import tsx src/index.ts
