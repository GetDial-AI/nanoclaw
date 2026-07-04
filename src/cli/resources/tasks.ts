import fs from 'fs';

import type Database from 'better-sqlite3';

import { getAllAgentGroups } from '../../db/agent-groups.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { cancelTask, pauseTask, resumeTask } from '../../modules/scheduling/db.js';
import { inboundDbPath, openInboundDb } from '../../session-manager.js';
import { registerResource } from '../crud.js';
import type { CallerContext } from '../frame.js';

/**
 * `ncl tasks` — the operator surface for scheduled tasks (cron jobs).
 *
 * Tasks are `messages_in` rows with `kind='task'` living in each session's
 * host-owned `inbound.db` — there is no central table, so the auto-CRUD in
 * crud.ts (which is central-DB-bound) can't back this resource. Instead we
 * iterate `getSessionsByAgentGroup` and open each session's `inbound.db`
 * directly from the host process, which is the sole legitimate writer of that
 * file (see session-manager.ts). This is the same shape destinations.ts uses
 * to project rows into live sessions.
 *
 * Before this existed the only way to stop a runaway recurring task was to ask
 * the (misbehaving) agent to cancel it via its container-side task tools.
 */

interface ProjectedTask {
  agent_group_id: string;
  session_id: string;
  /** The stable series handle — one row per series (see list_tasks). */
  id: string;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  prompt: string;
}

/**
 * Resolve which agent groups the caller may act on. Agent callers are pinned
 * to their own group (cli_scope=group), mirroring how groups/sessions/
 * destinations keep a container inside its own agent group. Host (operator)
 * callers may target one group via --group or every group when it's omitted.
 */
function targetAgentGroupIds(group: string | undefined, ctx: CallerContext): string[] {
  if (ctx.caller === 'agent') return [ctx.agentGroupId];
  if (group) return [group];
  return getAllAgentGroups().map((g) => g.id);
}

/**
 * Run `cb` against every session's host-owned inbound.db for the resolved
 * agent groups. Skips sessions whose inbound.db hasn't been created yet
 * (same guard as write-destinations.ts) so opening one never fabricates an
 * empty, schema-less DB file.
 */
function forEachSessionDb(
  groupIds: string[],
  cb: (db: Database.Database, agentGroupId: string, sessionId: string) => void,
): void {
  for (const agentGroupId of groupIds) {
    for (const session of getSessionsByAgentGroup(agentGroupId)) {
      if (!fs.existsSync(inboundDbPath(agentGroupId, session.id))) continue;
      const db = openInboundDb(agentGroupId, session.id);
      try {
        cb(db, agentGroupId, session.id);
      } finally {
        db.close();
      }
    }
  }
}

function taskPrompt(content: string): string {
  try {
    const parsed = JSON.parse(content) as { prompt?: unknown };
    return typeof parsed.prompt === 'string' ? parsed.prompt : '';
  } catch {
    return '';
  }
}

/** Count the live rows a control op would touch, so we can report `affected`. */
function countTargetRows(db: Database.Database, taskId: string, statuses: string[]): number {
  const placeholders = statuses.map(() => '?').join(', ');
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM messages_in
        WHERE (id = ? OR series_id = ?) AND kind = 'task' AND status IN (${placeholders})`,
    )
    .get(taskId, taskId, ...statuses) as { n: number };
  return row.n;
}

/**
 * Shared body for cancel/pause/resume. `statuses` is the set of live statuses
 * the underlying db.ts helper actually mutates, used only to report how many
 * rows were affected. The helper itself matches by id OR series_id, so a
 * recurring task's live next occurrence is caught, not just the row an agent
 * happens to remember.
 */
function control(
  args: Record<string, unknown>,
  ctx: CallerContext,
  statuses: string[],
  apply: (db: Database.Database, taskId: string) => void,
): { taskId: string; affected: number; sessions: string[] } {
  const taskId = args.id as string | undefined;
  if (!taskId) throw new Error('--id is required (task id or series id)');
  const groupIds = targetAgentGroupIds(args.group as string | undefined, ctx);

  let affected = 0;
  const sessions: string[] = [];
  forEachSessionDb(groupIds, (db, _agentGroupId, sessionId) => {
    const n = countTargetRows(db, taskId, statuses);
    if (n === 0) return;
    apply(db, taskId);
    affected += n;
    sessions.push(sessionId);
  });

  return { taskId, affected, sessions };
}

registerResource({
  name: 'task',
  plural: 'tasks',
  // Tasks aren't a central-DB table — they're messages_in rows in per-session
  // inbound.db files. `table` is unused because no generic CRUD op is enabled.
  table: 'messages_in',
  description:
    "Scheduled task (cron job) — a messages_in row with kind=task in a session inbound.db. Operator surface to inspect and stop tasks without going through the agent. list/get show one row per series; cancel/pause/resume match by id OR series id so a recurring task's live next occurrence is caught.",
  idColumn: 'id',
  scopeField: 'agent_group_id',
  columns: [
    { name: 'agent_group_id', type: 'string', description: 'Agent group whose session holds the task.' },
    { name: 'session_id', type: 'string', description: 'Session whose inbound.db holds the task.' },
    { name: 'id', type: 'string', description: 'Series id — the stable handle for the task.' },
    { name: 'status', type: 'string', description: '"pending" or "paused".' },
    { name: 'process_after', type: 'string', description: 'When the next occurrence is due (UTC).' },
    { name: 'recurrence', type: 'string', description: 'Recurrence rule, or null for a one-shot.' },
    { name: 'prompt', type: 'string', description: 'The task prompt the agent runs when it fires.' },
  ],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      description:
        'List pending and paused scheduled tasks (one row per series). Use --group to scope to a single agent group; defaults to all groups.',
      handler: async (args, ctx) => {
        const groupIds = targetAgentGroupIds(args.group as string | undefined, ctx);
        const tasks: ProjectedTask[] = [];
        forEachSessionDb(groupIds, (db, agentGroupId, sessionId) => {
          const rows = db
            .prepare(
              `SELECT series_id AS id, status, process_after, recurrence, content, MAX(seq) AS _seq
                 FROM messages_in
                WHERE kind = 'task' AND status IN ('pending', 'paused')
                GROUP BY series_id
                ORDER BY process_after ASC`,
            )
            .all() as Array<{
            id: string;
            status: string;
            process_after: string | null;
            recurrence: string | null;
            content: string;
          }>;
          for (const r of rows) {
            tasks.push({
              agent_group_id: agentGroupId,
              session_id: sessionId,
              id: r.id,
              status: r.status,
              process_after: r.process_after,
              recurrence: r.recurrence,
              prompt: taskPrompt(r.content),
            });
          }
        });
        return tasks;
      },
    },
    get: {
      access: 'open',
      description: 'Get a scheduled task by id or series id. Use --id <task-id>, optional --group.',
      handler: async (args, ctx) => {
        const taskId = args.id as string | undefined;
        if (!taskId) throw new Error('--id is required (task id or series id)');
        const groupIds = targetAgentGroupIds(args.group as string | undefined, ctx);
        let found: ProjectedTask | undefined;
        forEachSessionDb(groupIds, (db, agentGroupId, sessionId) => {
          if (found) return;
          const r = db
            .prepare(
              `SELECT series_id AS id, status, process_after, recurrence, content, MAX(seq) AS _seq
                 FROM messages_in
                WHERE kind = 'task' AND (id = ? OR series_id = ?) AND status IN ('pending', 'paused')
                GROUP BY series_id`,
            )
            .get(taskId, taskId) as
            | { id: string; status: string; process_after: string | null; recurrence: string | null; content: string }
            | undefined;
          if (r) {
            found = {
              agent_group_id: agentGroupId,
              session_id: sessionId,
              id: r.id,
              status: r.status,
              process_after: r.process_after,
              recurrence: r.recurrence,
              prompt: taskPrompt(r.content),
            };
          }
        });
        if (!found) throw new Error(`task not found: ${taskId}`);
        return found;
      },
    },
    cancel: {
      access: 'approval',
      description: 'Cancel a scheduled task (matches id or series id). Use --id <task-id>, optional --group.',
      handler: async (args, ctx) => control(args, ctx, ['pending', 'paused'], cancelTask),
    },
    pause: {
      access: 'approval',
      description: 'Pause a scheduled task so it stops firing until resumed. Use --id <task-id>, optional --group.',
      handler: async (args, ctx) => control(args, ctx, ['pending'], pauseTask),
    },
    resume: {
      access: 'approval',
      description: 'Resume a paused scheduled task. Use --id <task-id>, optional --group.',
      handler: async (args, ctx) => control(args, ctx, ['paused'], resumeTask),
    },
  },
});
