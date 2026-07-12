---
name: add-audit
description: Add an opt-in local audit log for the ncl command surface and every host-routed approval — each command's dispatch outcome on both transports (host socket and container, scope denials included), plus each approval's request and decision (approved/rejected, across CLI, self-mod, a2a, sender admission, OneCLI, channel registration), written as SIEM-shaped append-only NDJSON day-files under data/audit/. Read back with `ncl audit list`; plug exporters in via registerAuditHook. Off until AUDIT_ENABLED=true.
---

# /add-audit — Local Audit Log (ncl surface + approvals)

Records one canonical audit event for two surfaces:

1. **Every `ncl` command** — human over the host socket or agent over the
   container transport, denials included. Both transports converge on the
   exported `dispatch`, so one composition covers the whole surface: no second
   door.
2. **Every host-routed approval** — its `pending` request and its
   `approvals.decide` decision (approved / rejected), whichever stack gated it:
   CLI commands, self-mod (`install_packages` / `add_mcp_server`), a2a
   create-agent and message-gate, unknown-sender admission, OneCLI credential
   holds, and channel registration. Two lifecycle observers cover them all with
   zero touch points inside the approval flows.

```
ncl (host socket) ──┐
                    ├─→ dispatch = withAudit(dispatchInner) ─→┐
container cli_request ┘        │                              │
approved replay (grant) ───────┘                              ├─→ one NDJSON line
                                                              │   data/audit/<UTC-day>.ndjson
every hold ─→ requested observer ─→ pending ─────────────────┤
every resolution ─→ resolved observer ─→ approvals.decide ───┘
```

What one event carries: `actor` (`host:<os-user>`, the agent group, a
`<channel>:<handle>` admin for a decision, or `system` for an expiry/sweep),
`origin` (transport, session, channel), dotted `action` from the guard catalog
(e.g. `groups.config.add-mcp-server`, `agents.create`, `approvals.decide`),
touched/attempted `resources` (a gated chain names its `approval` and, on the
`pending` event, the picked approver as a `user`), `outcome` (`success ·
failure · denied · pending · approved · rejected`), `correlation_id` (the
approval id on gated chains — the `pending` request, the `approvals.decide`
decision, and a CLI replay's terminal event all share it, so `--correlation
<id>` returns the whole chain), and `details` (governance-safe names only —
never raw argument values).

Two adapters, one leaf: the CLI adapter (`cli/dispatch.audit.ts`) owns command
events and the CLI hold's `pending`; the approvals adapter
(`modules/approvals/approvals.audit.ts`) owns every non-CLI `pending` and every
decision. Both call the same domain-free `src/audit/` emit/store. Later
surfaces (message traffic, tool calls, container lifecycle) attach the same way
— a new `*.audit.ts` adapter, no schema change.

## Steps

### 0. Pre-flight (idempotency)

The apply is safe to re-run; every step below is guarded. Skip to
**Enable** if all of these already hold:

- `src/audit/` exists
- `src/cli/resources/index.ts` contains `import './audit.js';`
- `src/cli/dispatch.ts` contains `export const dispatch = withAudit(dispatchInner);`
- `src/modules/approvals/index.ts` contains `import './approvals.audit.js';`

Before editing, verify the reach-in targets still exist: `src/cli/dispatch.ts`
must contain `export async function dispatch(` (or the already-applied
composition), `src/cli/resources/index.ts` must be the resource barrel (a list
of `import './<resource>.js';` lines), and `src/modules/approvals/index.ts`
must be the approvals barrel exposing the lifecycle observers
(`registerApprovalRequestedHandler` / `registerApprovalResolvedHandler` in
`./primitive.js`). If any has moved, stop and adapt rather than guessing.

### 1. Copy the payload

From the NanoClaw project root:

```bash
cp -R "${CLAUDE_SKILL_DIR}/add/src/." src/
```

What lands (mirrors of the destination paths):

- `src/audit/` — the domain-free leaf: event schema (`types.ts`), env config
  (`config.ts`), redactor, NDJSON day-file store, emit seam, post-write hooks,
  reader, boot/maintenance wiring, vocabulary — plus its tests.
- `src/cli/dispatch.audit.ts` — the CLI adapter: `withAudit` middleware and
  the actor/origin/resource mapping (+ `dispatch.audit.test.ts`).
- `src/modules/approvals/approvals.audit.ts` — the approvals adapter: the two
  lifecycle-observer subscriptions that emit `pending` and `approvals.decide`
  (+ `approvals.audit.test.ts`).
- `src/cli/resources/audit.ts` — the read-only `ncl audit` resource.
- `src/audit-wiring.test.ts` — goes red if any of the three core edits below is
  deleted or drifts.

### 2. Register the resource

Append to `src/cli/resources/index.ts` (skip if the line is already present):

```typescript
import './audit.js';
```

### 3. Compose the dispatch middleware

This is the skill's one functional reach-in, in `src/cli/dispatch.ts`. Three
small edits:

1. Add the import (next to the other `./` imports):

   ```typescript
   import { withAudit } from './dispatch.audit.js';
   ```

2. Rename the dispatcher declaration — change

   ```typescript
   export async function dispatch(
   ```

   to

   ```typescript
   async function dispatchInner(
   ```

3. Directly after that function's closing brace (before the
   `registerApprovalHandler('cli_command', …)` block), add:

   ```typescript
   // Audit middleware (installed by /add-audit): the exported dispatch is the
   // wrapped function, so both transports and the approved replay below all
   // pass the one composition.
   export const dispatch = withAudit(dispatchInner);
   ```

The composition must live at the definition site (not at the import sites):
the approved-replay handler in the same file calls `dispatch(...)` too, and
only the wrapped export covers it. `src/audit-wiring.test.ts` asserts exactly
this shape via the TypeScript AST.

Loading `dispatch.audit.ts` also boots the audit log: on an enabled box it
asserts `data/audit/` is writable (refusing to start beats a silent audit
gap), runs the boot retention prune, and arms an unref'd maintenance timer.
(The approvals adapter in the next step boots it too — idempotent — so the
approval surface records even on a build that loads it first.)

### 4. Wire the approval observers

The approval-lifecycle increment's one reach-in, in the approvals barrel
`src/modules/approvals/index.ts`. Append a side-effect import (next to the
other module imports; skip if already present):

```typescript
// Approval-lifecycle audit observers (installed by /add-audit): importing the
// adapter registers its request/decision observers at boot.
import './approvals.audit.js';
```

Importing the adapter is what registers its two observers
(`registerApprovalRequestedHandler` / `registerApprovalResolvedHandler` from
`./primitive.js`) — the request/decision events for every non-CLI hold. The
barrel already loads at boot via `src/modules/index.ts`, and
`src/audit-wiring.test.ts` asserts the import is present. No `host-sweep.ts`
edit.

### 5. Enable

Add the two settings to `.env` (idempotent — overwrite or append):

```bash
grep -q '^AUDIT_ENABLED=' .env && sed -i.bak 's/^AUDIT_ENABLED=.*/AUDIT_ENABLED=true/' .env && rm -f .env.bak || echo 'AUDIT_ENABLED=true' >> .env
grep -q '^AUDIT_RETENTION_DAYS=' .env || echo 'AUDIT_RETENTION_DAYS=90' >> .env
```

`AUDIT_ENABLED` is the master switch — off (or absent) means `emitAuditEvent`
is a no-op and `data/audit/` is never created. `AUDIT_RETENTION_DAYS`: day
files strictly older than the horizon are hard-deleted (unlinked) at boot and
once per UTC day; `0` = keep forever; unset = 90.

### 6. Build and test

Run `build` before the tests — it's what catches a missed copy or a drifted
import path across the whole composed tree:

```bash
pnpm run build
pnpm exec vitest run src/audit src/cli/dispatch.audit.test.ts src/modules/approvals/approvals.audit.test.ts src/audit-wiring.test.ts
pnpm test
```

### 7. Restart the service

```bash
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)   # macOS
# systemctl --user restart $(systemd_unit)             # Linux
```

### 8. Verify (runtime smoke)

```bash
ncl groups list                     # any command — this one is now an audit event
cat data/audit/$(date -u +%F).ndjson | tail -1
ncl audit list --limit 5
ncl audit list --outcome pending    # what is waiting for approval right now
```

The last line of the day-file is the `groups.list` event you just caused. To
see the approval surface, drive a gated action (e.g. an agent asking to wire an
MCP server) and approve it, then `ncl audit list --correlation <approval-id>`
returns the full chain: `pending` → `approvals.decide` → the terminal event.

## Reading it back

```
ncl audit list [--actor <id>] [--action <name-or-prefix>] [--resource <id-or-type>]
               [--outcome success|failure|denied|pending|approved|rejected]
               [--since 7d|24h|30m|ISO] [--until …] [--correlation <approval-id>]
               [--limit N] [--format ndjson]
```

Newest first, default limit 100. `--action groups.config` matches the whole
dotted subtree. `--format ndjson` streams the stored lines verbatim — pipe to
a file for SIEM import. On a disabled box the command errors with
`audit log is disabled — set AUDIT_ENABLED=true` rather than returning an
empty list that would read as "no actions happened".

The resource is deliberately **not** on the group-scope allowlist: audit
spans agent groups, so group-scoped agents are refused before the handler
(fails closed). Host callers and `cli_scope: global` agents only.

## Recording model, failure posture, exporters

- Events store WHO did WHICH action to WHAT target and the outcome — **never
  raw argument values**. `details` carries the flag names that were passed plus
  a small allowlist of governance-relevant enum fields (`role`, `mode`,
  `session_mode`, `cli_scope`, `access`, `engage_mode`, `sender_scope`,
  `provider`, `model`) echoed verbatim; every other value is name-only, and a
  failure keeps the error *code*, never the free-text message. There is no value
  redactor — a secret can't leak from a value that is never stored. Target
  identifiers (ids, users, groups) surface structurally in `resources`.
- Fail-open + loud: a failed append is `log.error`'d and the audited action
  proceeds — the emit brackets the dispatcher, so even a command that *throws*
  still leaves a record. At boot, an enabled box refuses to start if
  `data/audit/` isn't writable.
- In-process exporters register via `registerAuditHook` (from
  `src/audit/index.js`) — post-write hooks that fire only after the local
  append succeeds, so an external system can never be ahead of the source of
  truth. Ship one as its own `/add-*` skill; declare `/add-audit` as its
  dependency.

## Troubleshooting

- **Host won't start, banner names the audit directory** — `AUDIT_ENABLED=true`
  but `data/audit/` isn't writable. Fix permissions or disable audit.
- **`audit log is disabled — set AUDIT_ENABLED=true`** — the read-back guard;
  enable in `.env` and restart.
- **An agent gets "CLI access is scoped to this agent group" for `ncl audit`**
  — by design; grant the group `cli_scope: global` only if it should read
  cross-group history.
- **`pnpm test` on an enabled box adds a few events to today's day-file** —
  expected: the base dispatch tests drive real dispatches. Harmless noise;
  the audit test suites themselves write only to temp dirs or capture buffers.

## Removal

See [REMOVE.md](REMOVE.md) — reverses every change; existing day-files are
left in place (they're the operator's records).
