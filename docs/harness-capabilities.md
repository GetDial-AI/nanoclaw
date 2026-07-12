# Harness capabilities

NanoClaw disables harness-native features that overlap its own systems, and exposes a small per-group toggle surface for the ones where both states are meaningful. Policy (keys, defaults, resolution) lives host-side in [`src/harness-capabilities.ts`](../src/harness-capabilities.ts); per-group overrides live in the `harness_capabilities` column of `container_configs`; mechanisms live in the agent runner and the settings reconciler ([`src/group-init.ts`](../src/group-init.ts)).

## Capability table

| Capability | Key | Default | Mechanism |
|---|---|---|---|
| Agent teams (experimental multi-agent coordination inside one session) | `agent-teams` | **off** | Settings reconciler adds/removes `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` in the group's `settings.json` on every spawn. On the pinned CLI, settings env strictly beats SDK options env, so the settings file is the only working switch. |
| Workflow tool (in-session multi-agent orchestration scripts) | `workflow` | **off** | Reconciler sets `disableWorkflows: true` (removes the tool and its agent-types catalog — ~26KB/turn); the runner also adds `Workflow` to `disallowedTools` + PreToolUse hook as a backstop. |
| Cron/scheduling (`CronCreate/CronDelete/CronList`, `ScheduleWakeup`) | — | fixed off | `disallowedTools` + hook. NanoClaw's `ncl tasks` is the authoritative scheduler. |
| `AskUserQuestion` | — | fixed off | `disallowedTools` (returns a placeholder headless; `ask_user_question` is the real mechanism). |
| Plan/worktree modes | — | fixed off | `disallowedTools` (broken headless). |
| `DesignSync` | — | fixed off | `disallowedTools` (desktop design-tool integration; nothing to sync with in a container; ~9.3KB/turn schema). |
| `ReportFindings` | — | fixed off | `disallowedTools` + hook (code-review-reporting UI affordance with no headless surface to receive it; ~1.9KB/turn schema). |
| Task list (`TaskCreate/…`), subagents (`Agent`), web (`WebSearch/WebFetch`) | — | fixed on | No NanoClaw overlap. Harness task lists are per-session scratch — not NanoClaw scheduled tasks. |

Toggling:

```bash
ncl groups config get --id <group-id>                                    # shows raw overrides + resolved view
ncl groups config update --id <group-id> --harness-capabilities 'agent-teams=on'
ncl groups config update --id <group-id> --harness-capabilities 'workflow=on,agent-teams=default'
ncl groups restart --id <group-id>                                       # apply
```

`default` clears the per-group override (it is never stored). For group-scoped containers (`cli_scope: group`, the default) harness-capability changes through `ncl` are rejected outright — like `cli_scope`, the sanctioned/persistent path is operator-only. A `cli_scope: global` container (owner agents set up via `/init-first-agent`) is unrestricted by design and goes through the normal CLI flow — treat approvals from such agents accordingly.

### Enforcement strength (be precise about the boundary)

- **`workflow` off** layers three mechanisms: the reconciled `disableWorkflows` settings key (primary — removes the tool and its agent-types catalog), the runner's PreToolUse hook (deterministic — blocks any Workflow invocation regardless of what shipped in context), and a runner-side `disallowedTools` entry. Schema-stripping via `disallowedTools` is **best-effort on the pinned CLI**: wire measurement shows it strips flag-gated tools on some query invocations and not others (see the [`dump-sdk-tools.ts`](../container/agent-runner/src/providers/dump-sdk-tools.ts) header), which is why the hook — not the strip — is the functional guarantee. The same applies to the fixed-off `DesignSync`/`ReportFindings` schemas: usually stripped, always invocation-blocked.
- **`agent-teams` off** has only one mechanism: the absence of the env key from the group's `settings.json`. That file is mounted **read-write** into the container (the CLI needs to write transcripts there), and `settingSources` also loads project/local settings from the agent-writable workspace — and workspace files **persist across respawns**. An agent that writes the teams key into its own user-scope settings is corrected at the next spawn; one that writes it into a workspace project/local settings file re-enables teams **until an operator removes that file**, because the reconciler manages only the user-scope file. Treat `agent-teams=off` as **configuration hygiene**, not a hard adversarial boundary — the real trust boundary remains the container sandbox + OneCLI. A planned follow-up will mount the managed settings source read-only and constrain `settingSources` to close this.

## Upgrade behavior — non-breaking (grandfathered)

Before this feature every group ran with agent teams on and Workflow available. Migration 020 **grandfathers every existing group** to that prior state — it stamps `{"agent-teams":"on","workflow":"on"}` onto each row that exists at upgrade time, and the startup backfill stamps the same state onto legacy groups whose config row is only created at boot — so **upgrading changes nothing for your current agents**. Only newly-created groups (and every group on a fresh install) get the lean defaults via the column default `{}`. The runner applies the same rule to a `container.json` missing the capability field (written by a pre-upgrade host mid-update): legacy all-on, so nothing flips off before the host restarts.

- **Verify after upgrade**: `ncl groups config get --id <g>` shows `harness_capabilities_resolved` with `{"state": "on", "source": "override"}` for both keys on pre-existing groups; their `settings.json` keeps the teams env key and has no `disableWorkflows`.
- **If you had hand-edited a group's `settings.json`** (e.g. deleted the teams env key yourself — the only pre-upgrade off-switch): the grandfather stamps the pre-feature *defaults*, and the reconciler now owns the managed keys, so the first post-upgrade spawn will re-add the teams key. Re-apply your intent the supported way: `ncl groups config update --id <g> --harness-capabilities 'agent-teams=off'`. Unmanaged keys in the file are never touched.
- **Opt an existing group into the lean defaults** (to get the ~20%/turn saving): `ncl groups config update --id <g> --harness-capabilities 'agent-teams=off,workflow=off'` then `ncl groups restart --id <g>`.
- **Re-enable on a new group**: `ncl groups config update --id <g> --harness-capabilities 'agent-teams=on,workflow=on'` then restart. The `ncl` command is the rollback — per group, no code changes.

Why the defaults are off for new groups: agent teams overlaps NanoClaw's a2a (`create_agent` + destinations), is experimental upstream, and multiplies separately-billed agents invisibly to ops; Workflow is redundant with NanoClaw's orchestration and is the single largest tool schema on every turn.

## Notes for forks

- If your fork patched `SDK_DISALLOWED_TOOLS` in `container/agent-runner/src/providers/claude.ts`: the fixed list still lives there, but per-group state now composes through `buildDisallowedTools()` — re-apply your patch to the fixed list, or express it as capability keys if it fits.
- The measured numbers above are for `@anthropic-ai/claude-code` 2.1.197 / SDK 0.3.197. When bumping the pin, `claude.tools.test.ts` fails until you regenerate the tool-surface fixture: run [`dump-sdk-tools.ts`](../container/agent-runner/src/providers/dump-sdk-tools.ts) inside the agent image (invocation in its header) and re-verify the allow/disallow lists against the new surface.
