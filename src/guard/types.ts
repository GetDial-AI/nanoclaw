/**
 * Guard vocabulary — the decision seam every privileged action passes.
 *
 * The guard is a domain-free leaf: this module may import the DB read layer,
 * config, log, and shared types — never src/cli/* or src/modules/*. Domain
 * knowledge (what an action's structural baseline checks) arrives via
 * definition: domain modules call defineGuardedAction (guard-actions.ts) at
 * their module edges and pass the returned value to every consult and
 * registration site — the wiring is a symbol reference the compiler checks.
 */
import type { PendingApproval } from '../types.js';

/** Who is attempting the action. Mirrors the CLI CallerContext + click identities. */
export type GuardActor =
  | { kind: 'host' }
  | { kind: 'agent'; agentGroupId: string; sessionId?: string }
  | { kind: 'human'; userId: string }
  | { kind: 'system' };

export interface GuardInput {
  actor: GuardActor;
  /** Domain resource reference, e.g. { from, to } for a2a.send. */
  resource?: Record<string, string>;
  /** Action arguments — what the card summarizes and rules may later match on. */
  payload: Record<string, unknown>;
  /**
   * Verified approval row carried by an approved replay. A valid grant
   * satisfies a hold (the human already decided) but never a deny — the
   * structural baseline is re-checked live on every replay.
   */
  grant?: PendingApproval | null;
}

declare const unguardedBrand: unique symbol;
/**
 * A registration that deliberately carries no guard. Omission is not
 * representable — every registry requires either a guard spec or this
 * marker, so the decision to run unguarded is visible, and justified, in
 * the diff that registers the handler. The reason travels with the
 * registration; `grep "unguarded("` is the complete inventory.
 */
export type Unguarded = { readonly reason: string; readonly [unguardedBrand]: true };

export function unguarded(reason: string): Unguarded {
  return Object.freeze({ reason }) as Unguarded;
}

export type GuardDecision =
  | { effect: 'allow'; reason: string }
  | { effect: 'hold'; reason: string; approverUserId?: string }
  | { effect: 'deny'; reason: string };

export const ALLOW = (reason: string): GuardDecision => ({ effect: 'allow', reason });
export const DENY = (reason: string): GuardDecision => ({ effect: 'deny', reason });
/**
 * approverUserId names an exclusive approver for the hold (the a2a policy
 * row's named approver). Absent, the hold goes to the approvals primitive's
 * default chain (scoped admins → global admins → owners).
 */
export const HOLD = (reason: string, approverUserId?: string): GuardDecision => ({
  effect: 'hold',
  reason,
  approverUserId,
});
