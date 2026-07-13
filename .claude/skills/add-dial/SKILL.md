---
name: add-dial
description: Add Dial channel integration — a real phone number for SMS and AI voice calls via the Dial platform (getdial.ai). Native adapter — no Chat SDK bridge.
---

# Add Dial Channel

Adds a real phone number to NanoClaw via a native adapter for [Dial](https://getdial.ai). Outbound SMS goes through the official `@getdial/sdk`; inbound (texts, ended calls) arrives via Dial's documented **CLI command-target** — no local HTTP endpoint. Inbound voice calls are answered by Dial's AI receptionist; the adapter surfaces the `call.ended` event so the agent can follow up.

Unlike a bot API, Dial gives the account its own phone number, auto-provisioned at signup. That number is modelled as a single **public, threaded line**: one messaging group whose `platform_id` is the Dial number itself, and each remote correspondent is a thread inside it (thread id = their E.164). One wiring with `unknown_sender_policy: 'public'` therefore lets anyone text or call the number and reach the agent with no per-sender approval, while replies still route back to the right person via their thread. Operator ownership is bootstrapped by a one-time **pairing** handshake: the operator texts a 4-digit code to the number, and the adapter records their number as owner before the message reaches an agent.

## Prerequisites

### The `dial` CLI

```bash
command -v dial || curl -fsSL https://getdial.ai/install | bash
dial --version
```

For the full onboarding/auth reference, see the `dial-cli` skill or `curl -fsSL https://getdial.ai/skills.md`.

### Sign in / provision a number

```bash
dial doctor --json         # nextStep: "ready" means you're already set up
```

If not signed in:

```bash
dial signup you@example.com                 # emails a 6-digit OTP
dial onboard --code 123456 \                # verifies + provisions your first US number
  --inbound-instruction "You are my receptionist. Greet the caller and find out what they need." \
  --agent nanoclaw                          # also installs the Dial skill for the container agent
```

`--inbound-instruction` is required only when onboarding provisions a new account's first number; it's ignored when signing in to an existing account. `dial onboard` writes `~/.local/share/dial/auth.v1.json` (mode 0600) — the adapter reads its `apiKey` and `phoneNumber` from there.

### Inbound event daemon

```bash
dial listen install        # user service (launchd/systemd) that fans out account events
```

This is what runs the command-target handler per event. In sandboxes/CI without a user service supervisor it can't run — outbound still works; inbound needs the daemon. See `dial listen --help`.

## Install

### Pre-flight (idempotent)

Skip to **Credentials** if all of these are already in place:

- `src/channels/dial.ts` exists
- `src/channels/dial-pairing.ts` exists (the SMS pairing store)
- `src/channels/dial-registration.test.ts` exists
- `container/skills/dial-cli/SKILL.md` exists (the bundled outbound-tool skill)
- `src/channels/index.ts` contains `import './dial.js';`
- `@getdial/sdk` is listed in `package.json` dependencies

Otherwise continue. Every step below is safe to re-run.

To add a **second** Dial number to an existing install, use the dedicated
`/add-dial-number` skill instead.

### 1. Fetch the channels branch

```bash
git fetch origin channels
```

### 2. Copy the adapter, test, and the dial-cli container skill

The `dial-cli` container skill is part of the channel payload (the WhatsApp/Slack pattern): it teaches the agent to drive the `dial` CLI for **outbound** — send SMS, place AI voice calls, reconfigure the number — from any channel it's on.

```bash
git show origin/channels:src/channels/dial.ts                    > src/channels/dial.ts
git show origin/channels:src/channels/dial-pairing.ts            > src/channels/dial-pairing.ts
git show origin/channels:src/channels/dial-pairing.test.ts       > src/channels/dial-pairing.test.ts
git show origin/channels:src/channels/dial-registration.test.ts  > src/channels/dial-registration.test.ts
mkdir -p container/skills/dial-cli
git show origin/channels:container/skills/dial-cli/SKILL.md       > container/skills/dial-cli/SKILL.md
```

### 3. Append the self-registration import

Append to `src/channels/index.ts` (skip if the line is already present):

```typescript
import './dial.js';
```

### 4. Install the SDK (pinned)

```bash
pnpm install @getdial/sdk@0.17.0
```

### 5. Build and validate

```bash
pnpm run build
pnpm exec vitest run src/channels/dial-registration.test.ts
```

Both must be clean before proceeding. `dial-registration.test.ts` is the one integration test: it imports the real channel barrel and asserts the registry contains `dial`. It goes red if the `import './dial.js';` line is deleted or drifts, if the barrel fails to evaluate, or if `@getdial/sdk` is missing (an unmocked import throws). The adapter's typed SDK consumption is guarded by `pnpm run build`.

## Credentials

No `.env` entry is required — the adapter reads Dial's own auth file
(`~/.local/share/dial/auth.v1.json`) written by `dial onboard`. If no API key
is found there, the channel is skipped at startup.

### Optional env override

```bash
# Path to the dial CLI (default: resolved on PATH). Set this if the service
# can't find `dial` (launchd/systemd run with a limited PATH). Used to
# register the inbound command target.
DIAL_CLI_PATH=/usr/local/bin/dial
```

If you set it, sync to the container: `mkdir -p data/env && cp .env data/env/env`

### Restart

Run from your NanoClaw project root:

```bash
source setup/lib/install-slug.sh

# macOS
launchctl kickstart -k gui/$(id -u)/$(launchd_label)

# Linux
systemctl --user restart $(systemd_unit)
```

## How inbound works (CLI command-target)

There is no inbound HTTP webhook. On startup the adapter:

1. Writes a small handler script to `data/dial/handle-dial-event.sh`.
2. Registers it with Dial as a command target: `dial local-target add cmd <handler>` (idempotent — skipped if already registered).
3. Watches `data/dial/inbound/` for spooled events.

For every account event the `dial listen` daemon runs the handler with the event JSON as its final positional argument; the handler spools the event to the watched directory, and the adapter routes `message.received` (external only) and `call.ended` through the normal entity model. Replies flow back out via the SDK as SMS.

If the `dial` CLI isn't on PATH at startup, or the listen daemon isn't running, the adapter logs a warning and keeps watching — set them up (`dial listen install`) and restart. Outbound is unaffected either way.

## Wiring

The Dial line is wired **once**, as a single public messaging group whose
`platform_id` is the Dial number itself. Every remote number that texts or
calls it lands in that one group as its own thread — new senders do **not**
create new messaging groups, and there is no per-sender approval to grant
(`unknown_sender_policy` is `public`).

The normal path is the setup wizard (`/setup` → connect Dial, or re-run the
Dial channel flow), which provisions the number, runs the pairing handshake,
and wires the public line for you. During pairing the operator texts a 4-digit
code to the Dial number; the running adapter consumes it, records that number
as a `dial:<E.164>` user, and grants it the `owner` role if the install has no
owner yet — all before the message reaches an agent.

### Inspecting the wired line

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT id, platform_id, unknown_sender_policy FROM messaging_groups WHERE channel_type='dial'"
```

The `platform_id` is the **Dial line number** (the agent's provisioned number),
not any sender's number, and `unknown_sender_policy` should read `public`.

### Manual wiring (only if not using the wizard)

Pass the messaging group `id` above to `/init-first-agent` or
`/manage-channels` to wire it to an agent group. `public` only takes effect
once the line is actually wired to an agent — an unwired line still holds
unknown senders for approval.

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, run `/init-first-agent` to create an agent and wire it to your Dial DM, or `/manage-channels` to wire this channel to an existing agent group.

## Channel Info

- **type**: `dial`
- **terminology**: Dial has phone numbers, SMS messages, and AI voice calls. The Dial number is a single public, threaded line — one messaging group with each remote correspondent as a thread — not a set of separate 1:1 chats.
- **supports-threads**: yes — each correspondent is a thread (thread id = their E.164) within the one messaging group.
- **platform-id-format**: the **Dial line number** in E.164 (`+14155550123`), sent as-is with no channel prefix. This is the messaging group's `platform_id`; each sender's own number is the thread id, not the `platform_id`.
- **how-to-find-id**: Query `messaging_groups` as shown above (`WHERE channel_type='dial'`). The `platform_id` is the Dial line number.
- **typical-use**: Personal assistant reachable by text; sends SMS, places AI voice calls, and receives 2FA codes and replies.
- **default-isolation**: One agent on one public Dial line. Anyone can reach it (`unknown_sender_policy: 'public'`), and each correspondent gets their own thread and session.

### Features

- SMS send/receive; long replies are chunked (~1500 chars/segment).
- AI voice calls — inbound calls are answered by Dial's receptionist (configured via the number's inbound instruction); `call.ended` is surfaced to the agent with a hint to run `dial call get <id>` for the transcript. The agent places outbound calls via the `dial` CLI (see the `dial-cli` skill).
- Event dedup — the listen daemon retries a failed handler once; the adapter drops duplicate event ids within a 5-minute window.

## Troubleshooting

### Channel skipped at startup

```bash
grep -i dial logs/nanoclaw.log | tail
```

`Dial: not signed in … skipping channel` means `dial onboard` hasn't run (no `~/.local/share/dial/auth.v1.json`). Confirm with `dial doctor --json` (`auth.signedIn: true`).

### Inbound texts never arrive

1. Listen daemon running? `dial doctor --json` → `listen.running: true`. If not: `dial listen install`.
2. Command target registered? `dial local-target list --json` should include `data/dial/handle-dial-event.sh`. The adapter registers it on boot; if `dial` wasn't on PATH then, set `DIAL_CLI_PATH` and restart, or register manually: `dial local-target add cmd "$PWD/data/dial/handle-dial-event.sh"`.
3. Spooled but not routed? Look for files piling up in `data/dial/inbound/` — a parse or routing error is logged in `logs/nanoclaw.log`.
4. Internal test messages (`source: "internal"`, e.g. dashboard test tools) are intentionally ignored — only real carrier traffic (`source: "external"`) is routed.

### Outbound send fails with 401

The API key in the auth file is stale. Re-run `dial onboard` (or check `dial doctor`), then restart NanoClaw.

### `dial` not on PATH under the service

launchd/systemd start NanoClaw with a limited PATH. If startup logs `dial CLI not found`, set `DIAL_CLI_PATH=/absolute/path/to/dial` in `.env`, sync to `data/env/env`, and restart.
