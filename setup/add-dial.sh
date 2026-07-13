#!/usr/bin/env bash
#
# Install the Dial adapter in an already-running NanoClaw checkout.
# Non-interactive — the operator-facing `dial` signup/onboard, number
# confirmation, and service restart live in setup/channels/dial.ts. This
# script only:
#
#   1. Fetches src/channels/dial.ts + dial-registration.test.ts and the
#      dial-cli container skill from the channels branch.
#   2. Appends the self-registration import to src/channels/index.ts.
#   3. Installs @getdial/sdk (pinned).
#   4. Builds.
#
# Dial credentials are NOT persisted here — the adapter reads them from Dial's
# own auth file (~/.local/share/dial/auth.v1.json, written by `dial onboard`),
# or from DIAL_API_KEY / DIAL_FROM_NUMBER env overrides. That keeps this script
# idempotent and re-runnable without re-auth. Restart is the caller's job (the
# wizard restarts the service; standalone /add-dial installs instruct it).
#
# Emits exactly one status block on stdout (ADD_DIAL) at the end. All chatty
# progress goes to stderr so setup:auto's raw-log capture sees the full story
# without cluttering the final block for the parser.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Keep in sync with .claude/skills/add-dial/SKILL.md.
SDK_VERSION="@getdial/sdk@0.17.0"

# shellcheck source=setup/lib/channels-remote.sh
source "$PROJECT_ROOT/setup/lib/channels-remote.sh"
CHANNELS_REMOTE=$(resolve_channels_remote)
CHANNELS_BRANCH="${CHANNELS_REMOTE}/channels"

emit_status() {
  local status=$1 error=${2:-}
  local already=${ADAPTER_ALREADY_INSTALLED:-false}
  echo "=== NANOCLAW SETUP: ADD_DIAL ==="
  echo "STATUS: ${status}"
  echo "SDK_VERSION: ${SDK_VERSION}"
  echo "ADAPTER_ALREADY_INSTALLED: ${already}"
  [ -n "$error" ] && echo "ERROR: ${error}"
  echo "=== END ==="
}

log() { echo "[add-dial] $*" >&2; }

need_install() {
  [ ! -f src/channels/dial.ts ] && return 0
  ! grep -q "^import './dial.js';" src/channels/index.ts 2>/dev/null && return 0
  return 1
}

ADAPTER_ALREADY_INSTALLED=true
if need_install; then
  ADAPTER_ALREADY_INSTALLED=false
  log "Fetching channels branch…"
  git fetch "$CHANNELS_REMOTE" channels >&2 2>/dev/null || {
    emit_status failed "git fetch ${CHANNELS_REMOTE} channels failed"
    exit 1
  }

  log "Copying adapter files from ${CHANNELS_BRANCH}…"
  for f in \
    src/channels/dial.ts \
    src/channels/dial-pairing.ts \
    src/channels/dial-pairing.test.ts \
    src/channels/dial-registration.test.ts
  do
    git show "${CHANNELS_BRANCH}:$f" > "$f" || {
      emit_status failed "git show ${CHANNELS_BRANCH}:$f failed"
      exit 1
    }
  done

  # Bundle the dial-cli container skill (outbound tool: drive the `dial` CLI
  # to send SMS, place calls, reconfigure the number) — the WhatsApp/Slack
  # pattern of shipping a channel's container skill with the channel.
  log "Copying the dial-cli container skill…"
  mkdir -p container/skills/dial-cli
  git show "${CHANNELS_BRANCH}:container/skills/dial-cli/SKILL.md" > container/skills/dial-cli/SKILL.md || {
    emit_status failed "git show ${CHANNELS_BRANCH}:container/skills/dial-cli/SKILL.md failed"
    exit 1
  }

  if ! grep -q "^import './dial.js';" src/channels/index.ts; then
    echo "import './dial.js';" >> src/channels/index.ts
  fi
fi

log "Installing ${SDK_VERSION}…"
pnpm install "${SDK_VERSION}" >&2 2>/dev/null || {
  emit_status failed "pnpm install ${SDK_VERSION} failed"
  exit 1
}

log "Building…"
pnpm run build >&2 2>/dev/null || {
  emit_status failed "pnpm run build failed"
  exit 1
}

emit_status success
