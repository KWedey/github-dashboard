#!/bin/bash
# Keeps the dashboard running across reboots and crashes. Re-run after moving the repo.
set -euo pipefail
dir="$(cd "$(dirname "$0")/.." && pwd)"
label=com.kwedey.github-dashboard
plist="$HOME/Library/LaunchAgents/$label.plist"
cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$dir/serve.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$dir/server.log</string>
  <key>StandardErrorPath</key><string>$dir/server.log</string>
</dict>
</plist>
PLIST
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "installed $plist"
