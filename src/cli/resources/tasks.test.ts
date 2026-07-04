/**
 * `ncl tasks` operator surface — the only host-side way to inspect and stop
 * scheduled tasks (cron jobs) without asking the agent that owns them.
 *
 * Tasks are `messages_in` rows with `kind='task'` in a session's inbound.db,
 * so the resource opens each session DB from the host (the legitimate writer),
 * the same way destinations.ts projects rows. These tests drive dispatch with
 * `caller: 'host'` — the path a real operator socket connection uses.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cli-tasks' };
});

const TEST_DIR = '/tmp/nanoclaw-test-cli-tasks';

import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { insertRecurrence, insertTask } from '../../modules/scheduling/db.js';
import { initSessionFolder, inboundDbPath, openInboundDb } from '../../session-manager.js';
import { dispatch } from '../dispatch.js';
// Side-effect import: registers the `tasks-*` commands.
import './tasks.js';

const AG = 'ag-tasks';
const SESSION = 'sess-tasks-1';

function now(): string {
  return new Date().toISOString();
}

function readTaskStatus(id: string): string | undefined {
  const db = new Database(inboundDbPath(AG, SESSION), { readonly: true });
  const row = db.prepare('SELECT status FROM messages_in WHERE id = ?').get(id) as { status: string } | undefined;
  db.close();
  return row?.status;
}

function seedTask(id: string, prompt: string): void {
  const db = openInboundDb(AG, SESSION);
  try {
    insertTask(db, {
      id,
      processAfter: now(),
      recurrence: null,
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt }),
    });
  } finally {
    db.close();
  }
}

describe('tasks CLI resource (operator surface)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = initTestDb();
    runMigrations(db);

    createAgentGroup({ id: AG, name: 'tasks', folder: 'tasks', agent_provider: null, created_at: now() });
    createSession({
      id: SESSION,
      agent_group_id: AG,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    });
    initSessionFolder(AG, SESSION);
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('list: returns a pending task from the session inbound.db', async () => {
    seedTask('task-1', 'water the plants');

    const resp = await dispatch({ id: 'req-list', command: 'tasks-list', args: {} }, { caller: 'host' });

    expect(resp.ok).toBe(true);
    const rows = (resp as { ok: true; data: unknown }).data as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent_group_id: AG,
      session_id: SESSION,
      id: 'task-1',
      status: 'pending',
      prompt: 'water the plants',
    });
  });

  it('cancel: cancels a task matched by its id', async () => {
    seedTask('task-1', 'water the plants');
    expect(readTaskStatus('task-1')).toBe('pending');

    const resp = await dispatch(
      { id: 'req-cancel', command: 'tasks-cancel', args: { id: 'task-1' } },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    expect((resp as { ok: true; data: { affected: number } }).data.affected).toBe(1);
    expect(readTaskStatus('task-1')).toBe('completed');
  });

  it('cancel: cancels a recurring follow-up matched by series id', async () => {
    // Original firing plus a live follow-up occurrence that shares the series
    // id but has a distinct row id — the shape recurrence produces. Cancelling
    // by the series id must reach the follow-up whose id != the arg.
    seedTask('series-1', 'daily standup');
    const db = openInboundDb(AG, SESSION);
    try {
      insertRecurrence(
        db,
        {
          id: 'series-1',
          kind: 'task',
          content: JSON.stringify({ prompt: 'daily standup' }),
          recurrence: 'daily',
          process_after: now(),
          platform_id: null,
          channel_type: null,
          thread_id: null,
          series_id: 'series-1',
        },
        'occ-2',
        now(),
      );
    } finally {
      db.close();
    }
    expect(readTaskStatus('occ-2')).toBe('pending');

    const resp = await dispatch(
      { id: 'req-cancel-series', command: 'tasks-cancel', args: { id: 'series-1' } },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    // Both the original row and the follow-up share series_id 'series-1'.
    expect((resp as { ok: true; data: { affected: number } }).data.affected).toBe(2);
    expect(readTaskStatus('occ-2')).toBe('completed');
    expect(readTaskStatus('series-1')).toBe('completed');
  });
});
