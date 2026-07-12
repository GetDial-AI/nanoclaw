/**
 * Approvals audit adapter — what the two lifecycle observers record. Audit is
 * force-enabled and the store's append is captured; the observer registration
 * is captured through a mock of the approvals primitive, then invoked directly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PendingApproval, Session } from '../../types.js';

const appended = vi.hoisted(() => ({ lines: [] as string[] }));
const handlers = vi.hoisted(
  () =>
    ({ requested: undefined, resolved: undefined }) as {
      requested?: (e: unknown) => unknown;
      resolved?: (e: unknown) => unknown;
    },
);

vi.mock('../../audit/config.js', () => ({ AUDIT_ENABLED: true, AUDIT_RETENTION_DAYS: 90 }));
vi.mock('../../audit/init.js', () => ({ initAuditLog: vi.fn(), maintainAudit: vi.fn() }));
vi.mock('../../audit/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../audit/store.js')>();
  return {
    ...actual,
    appendAuditLine: (line: string) => {
      appended.lines.push(line);
    },
  };
});
vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
// containerOrigin (via vocab) looks up the messaging group's channel.
vi.mock('../../db/messaging-groups.js', () => ({ getMessagingGroup: () => ({ channel_type: 'slack' }) }));
// Capture the observer handlers the adapter registers at module load.
vi.mock('./primitive.js', () => ({
  registerApprovalRequestedHandler: (h: (e: unknown) => unknown) => {
    handlers.requested = h;
  },
  registerApprovalResolvedHandler: (h: (e: unknown) => unknown) => {
    handlers.resolved = h;
  },
}));

// Loads the adapter (registers into `handlers`) with the mocks in place.
import './approvals.audit.js';

function events(): Array<Record<string, any>> {
  return appended.lines.map((l) => JSON.parse(l));
}
function last(): Record<string, any> {
  return events()[appended.lines.length - 1];
}

const AGENT_SESSION: Session = {
  id: 's1',
  agent_group_id: 'g1',
  messaging_group_id: 'mg1',
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'running',
  last_active: null,
  created_at: '2026-01-01T00:00:00.000Z',
};

function hold(action: string, over: Partial<PendingApproval> = {}): PendingApproval {
  return {
    approval_id: 'appr-1',
    session_id: 's1',
    request_id: 'appr-1',
    action,
    payload: '{}',
    created_at: '2026-01-01T00:00:00.000Z',
    agent_group_id: 'g1',
    channel_type: null,
    platform_id: null,
    platform_message_id: null,
    expires_at: null,
    status: 'pending',
    title: '',
    options_json: '[]',
    approver_user_id: null,
    approver_rule: 'admins-of-scope',
    dedup_key: null,
    ...over,
  };
}

beforeEach(() => {
  appended.lines = [];
});

describe('approvals audit — request (pending)', () => {
  it('records a non-CLI hold as pending: dotted action, picked approver, container origin', async () => {
    await handlers.requested!({ approval: hold('add_mcp_server'), session: AGENT_SESSION, deliveredTo: 'slack:UADMIN' });
    const e = last();
    expect(e.action).toBe('self_mod.add_mcp_server');
    expect(e.outcome).toBe('pending');
    expect(e.actor).toEqual({ type: 'agent', id: 'g1', email: null, user_id: null, group_ids: null });
    expect(e.origin).toEqual({ transport: 'container', session_id: 's1', messaging_group_id: 'mg1', channel: 'slack' });
    expect(e.correlation_id).toBe('appr-1');
    expect(e.resources).toContainEqual({ type: 'agent_group', id: 'g1' });
    expect(e.resources).toContainEqual({ type: 'approval', id: 'appr-1' });
    expect(e.resources).toContainEqual({ type: 'user', id: 'slack:UADMIN' });
  });

  it('skips cli_command — the dispatch adapter owns those holds', async () => {
    await handlers.requested!({ approval: hold('cli_command'), session: AGENT_SESSION, deliveredTo: 'slack:UADMIN' });
    expect(appended.lines).toHaveLength(0);
  });

  it('a sessionless sender hold records as the system actor on the host', async () => {
    await handlers.requested!({
      approval: hold('sender_admit', { agent_group_id: null, session_id: null }),
      session: null,
      deliveredTo: 'slack:UADMIN',
    });
    const e = last();
    expect(e.action).toBe('senders.admit');
    expect(e.actor.type).toBe('system');
    expect(e.origin).toEqual({ transport: 'socket' });
    // no agent_group resource when host-raised
    expect(e.resources.some((r: any) => r.type === 'agent_group')).toBe(false);
  });
});

describe('approvals audit — decision (approvals.decide)', () => {
  it('an approve records approved; actor is the deciding admin on their channel', async () => {
    await handlers.resolved!({ approval: hold('add_mcp_server'), session: AGENT_SESSION, outcome: 'approve', userId: 'slack:UADMIN' });
    const e = last();
    expect(e.action).toBe('approvals.decide');
    expect(e.outcome).toBe('approved');
    expect(e.actor).toEqual({ type: 'human', id: 'slack:UADMIN', email: null, user_id: null, group_ids: null });
    expect(e.origin).toEqual({ transport: 'channel', channel: 'slack' });
    expect(e.correlation_id).toBe('appr-1');
    expect(e.details.gated_action).toBe('self_mod.add_mcp_server');
    expect(e.details.requested_by).toBe('g1');
  });

  it('a reject records rejected, naming the gated action', async () => {
    await handlers.resolved!({ approval: hold('a2a_message_gate'), session: AGENT_SESSION, outcome: 'reject', userId: 'discord:UMOD' });
    const e = last();
    expect(e.action).toBe('approvals.decide');
    expect(e.outcome).toBe('rejected');
    expect(e.origin.channel).toBe('discord');
    expect(e.details.gated_action).toBe('a2a.send');
  });

  it('expiry decides as the system actor: rejected + reason expired', async () => {
    await handlers.resolved!({ approval: hold('onecli_credential'), session: null, outcome: 'expire', userId: '' });
    const e = last();
    expect(e.actor).toEqual({ type: 'system', id: 'host', email: null, user_id: null, group_ids: null });
    expect(e.origin).toEqual({ transport: 'socket' });
    expect(e.outcome).toBe('rejected');
    expect(e.details.reason).toBe('expired');
    expect(e.details.gated_action).toBe('onecli.credential.use');
  });

  it('startup sweep decides as the system actor with reason swept', async () => {
    await handlers.resolved!({ approval: hold('onecli_credential'), session: null, outcome: 'sweep', userId: '' });
    const e = last();
    expect(e.actor.type).toBe('system');
    expect(e.outcome).toBe('rejected');
    expect(e.details.reason).toBe('swept');
  });
});

describe('approvals audit — correlation chain', () => {
  it('the request and the decision share the approval id', async () => {
    const approval = hold('create_agent', { approval_id: 'appr-xyz', request_id: 'appr-xyz' });
    await handlers.requested!({ approval, session: AGENT_SESSION, deliveredTo: 'slack:UADMIN' });
    await handlers.resolved!({ approval, session: AGENT_SESSION, outcome: 'approve', userId: 'slack:UADMIN' });
    const [pending, decide] = events();
    expect(pending.action).toBe('agents.create');
    expect(pending.outcome).toBe('pending');
    expect(pending.correlation_id).toBe('appr-xyz');
    expect(decide.action).toBe('approvals.decide');
    expect(decide.correlation_id).toBe('appr-xyz');
  });
});
