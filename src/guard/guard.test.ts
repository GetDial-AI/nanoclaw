/**
 * Guard decision-function unit tests: the baseline is the decision (allow /
 * hold / deny returned as-is), grant semantics (satisfies holds, never
 * denies; invalid → refuse), the runtime backstop against forged action
 * values, and the fail-closed posture on a throwing baseline.
 *
 * Uses synthetic actions defined per test — the catalog is per-worker module
 * state with no reset, so action names are unique.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { guard } from './guard.js';
import { defineGuardedAction, type GuardedAction } from './guard-actions.js';
import { ALLOW, DENY, HOLD, type GuardInput } from './types.js';

const mockGetPendingApproval = vi.fn();
vi.mock('../db/sessions.js', () => ({
  getPendingApproval: (...args: unknown[]) => mockGetPendingApproval(...args),
}));
vi.mock('../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const AGENT = { kind: 'agent', agentGroupId: 'ag-1', sessionId: 'sess-1' } as const;

function input(extra: Partial<GuardInput> = {}): GuardInput {
  return { actor: AGENT, payload: {}, ...extra };
}

beforeEach(() => {
  mockGetPendingApproval.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('the baseline is the decision', () => {
  it('baseline allow → allow', () => {
    const action = defineGuardedAction({ action: 't.allow1', baseline: () => ALLOW('ok') });
    expect(guard(action, input()).effect).toBe('allow');
  });

  it('baseline hold → hold, default approver chain', () => {
    const action = defineGuardedAction({ action: 't.hold1', baseline: () => HOLD('needs approval') });
    const d = guard(action, input());
    expect(d.effect).toBe('hold');
    if (d.effect === 'hold') {
      expect(d.reason).toBe('needs approval');
      expect(d.approverUserId).toBeUndefined();
    }
  });

  it('baseline hold → hold, carrying a named approver', () => {
    const action = defineGuardedAction({ action: 't.hold2', baseline: () => HOLD('policy row', 'telegram:dana') });
    const d = guard(action, input());
    expect(d.effect).toBe('hold');
    if (d.effect === 'hold') expect(d.approverUserId).toBe('telegram:dana');
  });

  it('baseline deny → deny, carrying the reason', () => {
    const action = defineGuardedAction({ action: 't.deny1', baseline: () => DENY('structurally unauthorized') });
    const d = guard(action, input());
    expect(d.effect).toBe('deny');
    if (d.effect === 'deny') expect(d.reason).toBe('structurally unauthorized');
  });

  it('a forged action value (not from defineGuardedAction) is denied', () => {
    const forged = { action: 't.forged', baseline: () => ALLOW('never vetted') } as unknown as GuardedAction;
    const d = guard(forged, input());
    expect(d.effect).toBe('deny');
    if (d.effect === 'deny') expect(d.reason).toContain('undefined action');
  });
});

describe('grants', () => {
  const grantRow = (action: string) =>
    ({ approval_id: 'appr-1', action, payload: '{}' }) as unknown as NonNullable<GuardInput['grant']>;

  it('a valid live grant satisfies a hold', () => {
    const action = defineGuardedAction({
      action: 't.g1',
      approvalAction: 'g1_approved',
      baseline: () => HOLD('b'),
    });
    const grant = grantRow('g1_approved');
    mockGetPendingApproval.mockReturnValue(grant);
    expect(guard(action, input({ grant })).effect).toBe('allow');
  });

  it('a grant never satisfies a deny — the baseline is re-checked live', () => {
    const action = defineGuardedAction({
      action: 't.g2',
      approvalAction: 'g2_approved',
      baseline: () => DENY('revoked since'),
    });
    const grant = grantRow('g2_approved');
    mockGetPendingApproval.mockReturnValue(grant);
    const d = guard(action, input({ grant }));
    expect(d.effect).toBe('deny');
    if (d.effect === 'deny') expect(d.reason).toBe('revoked since');
  });

  it('a dead grant (row deleted) refuses instead of re-holding', () => {
    const action = defineGuardedAction({
      action: 't.g3',
      approvalAction: 'g3_approved',
      baseline: () => HOLD('b'),
    });
    mockGetPendingApproval.mockReturnValue(undefined);
    const d = guard(action, input({ grant: grantRow('g3_approved') }));
    expect(d.effect).toBe('deny');
  });

  it("a grant for a different action doesn't transfer", () => {
    const action = defineGuardedAction({
      action: 't.g4',
      approvalAction: 'g4_approved',
      baseline: () => HOLD('b'),
    });
    const grant = grantRow('other_action');
    mockGetPendingApproval.mockReturnValue(grant);
    expect(guard(action, input({ grant })).effect).toBe('deny');
  });

  it('a domain grantMatches binding can refuse a payload mismatch', () => {
    const action = defineGuardedAction({
      action: 't.g5',
      approvalAction: 'g5_approved',
      grantMatches: () => false,
      baseline: () => HOLD('b'),
    });
    const grant = grantRow('g5_approved');
    mockGetPendingApproval.mockReturnValue(grant);
    expect(guard(action, input({ grant })).effect).toBe('deny');
  });

  it('a grant on an already-allowed action is a no-op', () => {
    const action = defineGuardedAction({
      action: 't.g6',
      approvalAction: 'g6_approved',
      baseline: () => ALLOW('ok'),
    });
    const grant = grantRow('g6_approved');
    mockGetPendingApproval.mockReturnValue(grant);
    expect(guard(action, input({ grant })).effect).toBe('allow');
  });
});

describe('fail-closed posture', () => {
  it('a throwing baseline denies', () => {
    const action = defineGuardedAction({
      action: 't.f1',
      baseline: () => {
        throw new Error('boom');
      },
    });
    expect(guard(action, input()).effect).toBe('deny');
  });
});
