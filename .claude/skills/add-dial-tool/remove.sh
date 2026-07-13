#!/usr/bin/env bash
#
# Non-interactive uninstaller for the Dial container tool. Reverses add.sh.
# Idempotent. Emits one REMOVE_DIAL_TOOL status block.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$PROJECT_ROOT"

log() { echo "[remove-dial-tool] $*" >&2; }
CLI_REMOVED=false

# 1. Drop @getdial/cli from the image manifest.
if jq -e '.[] | select(.name=="@getdial/cli")' container/cli-tools.json >/dev/null 2>&1; then
  tmp=$(mktemp)
  jq 'map(select(.name != "@getdial/cli"))' container/cli-tools.json > "$tmp" && mv "$tmp" container/cli-tools.json
  CLI_REMOVED=true
  log "removed @getdial/cli from container/cli-tools.json"
fi

# 2. Remove the container skill + its per-session copies.
rm -rf container/skills/dial-cli
for s in data/v2-sessions/ag-*; do rm -rf "$s/.claude-shared/skills/dial-cli"; done

# 3. Remove the OneCLI credential + strip it from every agent.
if command -v onecli >/dev/null 2>&1; then
  SID=$(onecli secrets list 2>/dev/null | jq -r '.data[] | select(.name | test("(?i)dial")) | .id' | head -1 || true)
  if [ -n "$SID" ]; then
    for a in $(onecli agents list 2>/dev/null | jq -r '.data[].id' 2>/dev/null || true); do
      REM=$(onecli agents secrets --id "$a" 2>/dev/null | jq -r --arg id "$SID" '[.data[] | select(. != $id)] | join(",")' 2>/dev/null || true)
      onecli agents set-secrets --id "$a" --secret-ids "$REM" >&2 2>/dev/null || true
    done
    onecli secrets delete --id "$SID" >&2 2>/dev/null || true
    log "removed the Dial secret from the OneCLI vault"
  fi
fi

# 4. Rebuild (only if the manifest changed) + restart running containers.
if [ "$CLI_REMOVED" = true ]; then
  log "rebuilding the agent image without the CLI…"
  ./container/build.sh >&2
fi
docker ps --format '{{.ID}} {{.Names}}' 2>/dev/null | grep nanoclaw | awk '{print $1}' | xargs -r docker stop >/dev/null 2>&1 || true

echo "=== NANOCLAW SETUP: REMOVE_DIAL_TOOL ==="
echo "STATUS: success"
echo "CLI_REMOVED: ${CLI_REMOVED}"
echo "=== END ==="
