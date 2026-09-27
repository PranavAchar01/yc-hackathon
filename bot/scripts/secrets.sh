#!/usr/bin/env bash
# Export secrets from the macOS login Keychain into this shell's environment. Never writes them to disk.
# Usage: source scripts/secrets.sh
# Store one: copy the value, then  security add-generic-password -U -a "$USER" -s NAME -w "$(pbpaste)"
# (the interactive -w prompt truncates at 128 chars, too short for OpenAI keys)
ots_secret() {
  local name="$1" value
  value="$(security find-generic-password -s "$name" -w 2>/dev/null || true)"
  if [[ -n "$value" ]]; then
    export "$name=$value"
  fi
}

# Required: Slack, plus one LLM key (OpenAI preferred when both exist; OTS_LLM overrides)
ots_secret SLACK_BOT_TOKEN
ots_secret SLACK_APP_TOKEN
ots_secret OPENAI_API_KEY
ots_secret ANTHROPIC_API_KEY
# Optional: real slash-command registration via apps.manifest.update
ots_secret SLACK_APP_ID
ots_secret SLACK_CONFIG_TOKEN
ots_secret SLACK_CONFIG_REFRESH_TOKEN
# Optional: QM executor source auth, Memorable service
ots_secret OTS_QM_SIGNING_SECRET
ots_secret MEMORABLE_API_KEY
# Optional: the one inbox real demo sends may reach, as plus-addresses (you+dana@gmail.com)
ots_secret OTS_TEST_INBOX
# Optional: hosted library database (Neon). Unset = local docker Postgres on :5544
ots_secret OTS_DATABASE_URL
# Optional: Vercel Blob token for run videos in the library
ots_secret BLOB_READ_WRITE_TOKEN
unset -f ots_secret
