/**
 * Delivery-failure handling for module approvals (requestApproval).
 *
 * The row is created before the card is delivered. If delivery throws — or no
 * delivery adapter is wired — the row must be dropped so the requesting agent
 * hears the real failure immediately, instead of the row sitting until the
 * 7-day expiry sweep clears it with a misleading "timed out" message. Mirrors
 * the sender/channel delivery-failure tests.
 */
import fs from 'fs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createSession } from '../../db/sessions.js';
import { upsertUser } from '../permissions/db/users.js';
import { grantRole } from '../permissions/db/user-roles.js';
import type { Session } from '../../types.js';

// Delivery adapter is swapped per-test via `adapterValue`.
const deliverMock = vi.fn().mockResolvedValue('plat-msg-id');
let adapterValue: { deliver: typeof deliverMock } | null = { deliver: deliverMock };
vi.mock('../../delivery.js', () => ({
  getDeliveryAdapter: () => adapterValue,
}));

// notifyAgent writes to the session inbound.db and wakes the container; stub
// both so the failure path doesn't need a real session folder or docker.
const writeSessionMessageMock = vi.fn();
vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: (...args: unknown[]) => writeSessionMessageMock(...args),
}));
const wakeContainerMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../container-runner.js', () => ({
  wakeContainer: (...args: unknown[]) => wakeContainerMock(...args),
  isContainerRunning: () => false,
  getActiveContainerCount: () => 0,
  killContainer: vi.fn(),
}));

// Resolve the approver's DM from the user_dms table instead of a real openDM RPC.
vi.mock('../permissions/user-dm.js', () => ({
  ensureUserDm: vi.fn(async (userId: string) => {
    const { getDb } = await import('../../db/connection.js');
    return getDb()
      .prepare(
        `SELECT mg.* FROM messaging_groups mg
           JOIN user_dms ud ON ud.messaging_group_id = mg.id
          WHERE ud.user_id = ?`,
      )
      .get(userId);
  }),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-primitive-approval' };
});

const TEST_DIR = '/tmp/nanoclaw-test-primitive-approval';

function now() {
  return new Date().toISOString();
}

function pendingCount(db: { prepare: (sql: string) => { get: () => unknown } }) {
  return (db.prepare('SELECT COUNT(*) AS c FROM pending_approvals').get() as { c: number }).c;
}

const SESSION: Session = {
  id: 'sess-1',
  agent_group_id: 'ag-1',
  messaging_group_id: 'mg-chat',
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'stopped',
  last_active: now(),
  created_at: now(),
};

async function requestApprovalOnce() {
  const { requestApproval } = await import('./primitive.js');
  await requestApproval({
    session: SESSION,
    agentName: 'Agent',
    action: 'install_packages',
    payload: { packages: ['jq'] },
    title: 'Install packages?',
    question: 'The agent wants to install: jq',
  });
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: 'mg-chat',
    channel_type: 'telegram',
    platform_id: 'chat-123',
    name: 'Group Chat',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  createSession(SESSION);

  // Owner + their DM messaging group — the approver requestApproval delivers to.
  upsertUser({ id: 'telegram:owner', kind: 'telegram', display_name: 'Owner', created_at: now() });
  grantRole({ user_id: 'telegram:owner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
  createMessagingGroup({
    id: 'mg-dm-owner',
    channel_type: 'telegram',
    platform_id: 'dm-owner',
    name: 'Owner DM',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  const { getDb } = await import('../../db/connection.js');
  getDb()
    .prepare(
      `INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run('telegram:owner', 'telegram', 'mg-dm-owner', now());

  adapterValue = { deliver: deliverMock };
  deliverMock.mockClear();
  writeSessionMessageMock.mockClear();
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('requestApproval delivery failure', () => {
  it('keeps the pending row when the card delivers', async () => {
    const { getDb } = await import('../../db/connection.js');
    await requestApprovalOnce();

    expect(deliverMock).toHaveBeenCalledTimes(1);
    expect(pendingCount(getDb())).toBe(1);
  });

  it('drops the pending row when card delivery throws', async () => {
    const { getDb } = await import('../../db/connection.js');
    deliverMock.mockRejectedValueOnce(new Error('delivery boom'));

    await requestApprovalOnce();

    expect(deliverMock).toHaveBeenCalledTimes(1);
    // Row rolled back so the agent isn't blocked for 7 days behind a lost card...
    expect(pendingCount(getDb())).toBe(0);
    // ...and it was told about the failure now.
    expect(writeSessionMessageMock).toHaveBeenCalledTimes(1);
  });

  it('drops the pending row when no delivery adapter is wired', async () => {
    const { getDb } = await import('../../db/connection.js');
    adapterValue = null;

    await requestApprovalOnce();

    expect(deliverMock).not.toHaveBeenCalled();
    expect(pendingCount(getDb())).toBe(0);
    expect(writeSessionMessageMock).toHaveBeenCalledTimes(1);
  });
});
