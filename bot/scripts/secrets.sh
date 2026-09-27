#!/usr/bin/env bash
# Export secrets from the macOS login Keychain into this shell's environment. Never writes them to disk.
# Usage: source scripts/secrets.sh
# Store one:  security add-generic-password -a "$USER" -s NAME -w      (prompts; nothing lands in shell history)
ots_secret() {
  local name="$1" value
  value="$(security find-generic-password -s "$name" -w 2>/dev/null || true)"
  if [[ -n "$value" ]]; then
    export "$name=$value"
  fi
}

# Required
ots_secret SLACK_BOT_TOKEN
ots_secret SLACK_APP_TOKEN
ots_secret ANTHROPIC_API_KEY
# Optional: real slash-command registration via apps.manifest.update
ots_secret SLACK_APP_ID
ots_secret SLACK_CONFIG_TOKEN
ots_secret SLACK_CONFIG_REFRESH_TOKEN
# Optional: QM executor source auth, GBrain semantic search, Memorable service
ots_secret OTS_QM_SIGNING_SECRET
ots_secret OPENAI_API_KEY
ots_secret MEMORABLE_API_KEY
unset -f ots_secret
