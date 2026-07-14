#!/usr/bin/env bash
#
# Start the NanoClaw host with its outbound HTTPS routed through the OneCLI
# gateway, so channel adapters (e.g. Dial in NANOCLAW_DIAL_ONECLI mode) get
# their credentials injected by OneCLI instead of reading them from .env /
# local auth files. See scripts/onecli-host-env.mjs for the mechanism.
#
# Drop-in replacement for `node dist/index.js` — if OneCLI isn't reachable it
# just starts the host normally (the env script emits nothing).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NODE_BIN="${NODE_BIN:-node}"
ENTRY="${ENTRY:-dist/index.js}"

# Pull the OneCLI gateway proxy env (HTTPS_PROXY / NODE_USE_ENV_PROXY /
# NODE_EXTRA_CA_CERTS) and apply it to this shell before exec-ing the host.
ONECLI_ENV="$("$NODE_BIN" "$ROOT/scripts/onecli-host-env.mjs" 2>/dev/null || true)"
if [ -n "$ONECLI_ENV" ]; then
  # shellcheck disable=SC1090
  eval "$ONECLI_ENV"
  echo "[host-onecli] outbound routed through the OneCLI gateway ($HTTPS_PROXY)" >&2
else
  echo "[host-onecli] OneCLI gateway not available — starting host normally" >&2
fi

exec "$NODE_BIN" "$ENTRY"
