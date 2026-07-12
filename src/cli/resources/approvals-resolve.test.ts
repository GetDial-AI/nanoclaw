/**
 * Operator approval-resolution verbs (`ncl approvals approve|reject|
 * reject-with-reason`). Drives `resolveApprovalFromCli` directly with a
 * fabricated caller context + seeded DB state, asserting the host-only guard,
 * the authorization check, and that each decision routes to the real
 * resolution (handler run on approve; row consumed; reason relayed).
 */
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { createPendingApproval, createSession, getPendingApproval } from '../../db/sessions.js';
import { registerApprovalHandler } from '../../modules/approvals/primitive.js';
import { grantRole } from '../../modules/permissions/db/user-roles.js';
import { upsertUser } from '../../modules/permissions/db/users.js';
import { initSessionFolder } from '../../session-manager.js';
import type { CallerContext } from '../frame.js';
import { resolveApprovalFromCli } from './approvals-resolve.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-approvals-resolve' };
});

const TEST_DIR = '/tmp/nanoclaw-test-approvals-resolve';
const HOST: CallerContext = { caller: 'host' };
const AGENT: CallerContext = { caller: 'agent', sessionId: 'sess-1', agentGroupId: 'ag-1', messagingGroupId: 'mg-1' };

const now = () => new Date().toISOString();

function seedApproval(approvalId: string, action: string): void {
  createPendingApproval({
    approval_id: approvalId,
    session_id: 'sess-1',
    request_id: approvalId,
    action,
    payload: JSON.stringify({}),
    created_at: now(),
    title: 'Test approval',
    options_json: JSON.stringify([]),
  });
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  createSession({
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  });
  initSessionFolder('ag-1', 'sess-1');

  upsertUser({ id: 'cli:owner', kind: 'cli', display_name: 'Owner', created_at: now() });
  grantRole({ user_id: 'cli:owner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
  upsertUser({ id: 'cli:stranger', kind: 'cli', display_name: 'Stranger', created_at: now() });
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('resolveApprovalFromCli — operator approval resolution', () => {
  it('rejects an agent caller (self-approval guard) and leaves the row', async () => {
    seedApproval('appr-1', 'cli_command');
    await expect(resolveApprovalFromCli({ id: 'appr-1', as_user: 'cli:owner' }, AGENT, 'approve')).rejects.toThrow(
      /operator \(host\)/,
    );
    expect(getPendingApproval('appr-1')).toBeTruthy();
  });

  it('errors on a missing approval', async () => {
    await expect(resolveApprovalFromCli({ id: 'nope', as_user: 'cli:owner' }, HOST, 'approve')).rejects.toThrow(
      /no pending approval/,
    );
  });

  it('rejects an unauthorized approver and leaves the row', async () => {
    seedApproval('appr-2', 'cli_command');
    await expect(resolveApprovalFromCli({ id: 'appr-2', as_user: 'cli:stranger' }, HOST, 'approve')).rejects.toThrow(
      /not authorized/,
    );
    expect(getPendingApproval('appr-2')).toBeTruthy();
  });

  it('requires --id and --as-user', async () => {
    await expect(resolveApprovalFromCli({ as_user: 'cli:owner' }, HOST, 'approve')).rejects.toThrow(/--id is required/);
    await expect(resolveApprovalFromCli({ id: 'x' }, HOST, 'approve')).rejects.toThrow(/--as-user is required/);
  });

  it('approve runs the registered action handler and consumes the row', async () => {
    const calls: string[] = [];
    registerApprovalHandler('cli_test_approve', async () => {
      calls.push('ran');
    });
    seedApproval('appr-3', 'cli_test_approve');

    const res = await resolveApprovalFromCli({ id: 'appr-3', as_user: 'cli:owner' }, HOST, 'approve');

    expect(calls).toEqual(['ran']);
    expect(res).toMatchObject({ approval_id: 'appr-3', action: 'cli_test_approve', resolved: 'approve' });
    expect(getPendingApproval('appr-3')).toBeUndefined();
  });

  it('reject consumes the row without running the action handler', async () => {
    const calls: string[] = [];
    registerApprovalHandler('cli_test_reject', async () => {
      calls.push('ran');
    });
    seedApproval('appr-4', 'cli_test_reject');

    const res = await resolveApprovalFromCli({ id: 'appr-4', as_user: 'cli:owner' }, HOST, 'reject');

    expect(calls).toEqual([]);
    expect(res.resolved).toBe('reject');
    expect(getPendingApproval('appr-4')).toBeUndefined();
  });

  it('reject-with-reason consumes the row and carries the trimmed reason', async () => {
    seedApproval('appr-5', 'cli_command');

    const res = await resolveApprovalFromCli(
      { id: 'appr-5', as_user: 'cli:owner', reason: '  not this quarter  ' },
      HOST,
      'reject-with-reason',
    );

    expect(res).toMatchObject({ approval_id: 'appr-5', resolved: 'reject', reason: 'not this quarter' });
    expect(getPendingApproval('appr-5')).toBeUndefined();
  });

  it('reject-with-reason requires a reason and leaves the row on omission', async () => {
    seedApproval('appr-6', 'cli_command');
    await expect(
      resolveApprovalFromCli({ id: 'appr-6', as_user: 'cli:owner' }, HOST, 'reject-with-reason'),
    ).rejects.toThrow(/--reason is required/);
    expect(getPendingApproval('appr-6')).toBeTruthy();
  });

  it('namespaces a bare --as-user against the cli channel', async () => {
    seedApproval('appr-7', 'cli_command');
    // 'owner' → 'cli:owner', the seeded owner
    const res = await resolveApprovalFromCli({ id: 'appr-7', as_user: 'owner' }, HOST, 'reject');
    expect(res.resolved).toBe('reject');
    expect(getPendingApproval('appr-7')).toBeUndefined();
  });
});
