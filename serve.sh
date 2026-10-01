#!/bin/bash
# Runs the server in the foreground; launchd starts this at login and restarts it if it exits.
cd "$(dirname "$0")"
[ -f .env ] && set -a && . ./.env && set +a
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
if ! command -v node >/dev/null; then
  latest=$(ls -d "$HOME"/.nvm/versions/node/v*/bin 2>/dev/null | sort -V | tail -1)
  [ -n "$latest" ] && export PATH="$latest:$PATH"
fi
exec node server.mjs
