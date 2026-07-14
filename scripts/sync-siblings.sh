#!/usr/bin/env bash
# Syncs shared bot logic from exitbot-evan to every sibling exit-bot
# (exitbot-papa, exitbot-mama, exitbot-catey, ...), leaving each one's
# wallet-specific/secret files untouched (.env, secrets/ — including its own
# encrypt-key.sh with its own age pubkey — state/, logs/). Restarts each
# sibling via pm2 afterward so the change takes effect immediately.
#
# Invoked automatically by scripts/sync-watcher.js whenever a shared file's
# mtime changes; safe to run manually too. Add a new sibling name to
# SIBLINGS below whenever another exitbot-* clone is created.
set -euo pipefail

SIBLINGS=(papa mama catey)

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for NAME in "${SIBLINGS[@]}"; do
  DST="/home/ubuntu/exitbot-$NAME"

  if [ ! -d "$DST" ]; then
    echo "exitbot-$NAME not found at $DST — skipping"
    continue
  fi

  rsync -a \
    --exclude node_modules \
    --exclude .env \
    --exclude secrets \
    --exclude state \
    --exclude logs \
    --exclude .git \
    --exclude package-lock.json \
    --exclude scripts/encrypt-key.sh \
    --exclude scripts/sync-siblings.sh \
    --exclude scripts/sync-watcher.js \
    "$SRC"/ "$DST"/

  sed -i "s/exitbot-evan/exitbot-$NAME/g" \
    "$DST"/*.js "$DST"/api/*.js "$DST"/package.json "$DST"/CLAUDE.md 2>/dev/null || true

  SRC_DEPS=$(node -e "console.log(JSON.stringify(require('$SRC/package.json').dependencies))")
  DST_DEPS=$(node -e "console.log(JSON.stringify(require('$DST/package.json').dependencies))" 2>/dev/null || echo "")
  if [ "$SRC_DEPS" != "$DST_DEPS" ]; then
    echo "Dependencies changed — running npm install in $DST"
    (cd "$DST" && npm install)
  fi

  if pm2 describe "exitbot-$NAME" >/dev/null 2>&1; then
    pm2 restart "exitbot-$NAME" --update-env
  else
    echo "exitbot-$NAME not yet running under pm2 — sync applied, no restart needed"
  fi

  echo "Synced exitbot-evan -> exitbot-$NAME at $(date -u +%FT%TZ)"
done
