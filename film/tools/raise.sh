#!/bin/zsh
# Bring the Slack Chrome window to the front (agent windows open at the same size and position, on top of it).
osascript -e 'tell application "Google Chrome"
  activate
  repeat with w in windows
    if URL of active tab of w contains "app.slack.com/client" then set index of w to 1
  end repeat
end tell' >/dev/null
