/**
 * Approvals audit adapter (installed by /add-audit) — records the approval
 * lifecycle for every host-routed hold, whichever stack created it: CLI
 * commands, self-mod (install_packages / add_mcp_server), a2a create-agent and
 * message-gate, unknown-sender admission, OneCLI credential holds, and channel
 * registration. It subscribes to the two approval lifecycle observers, so the
 * approval flows themselves contain zero audit calls.
 *
 *  - request → a `pending` event naming the picked approver (a `user`
 *    resource), correlated by the approval id. `cli_command` is skipped: the
 *    CLI adapter (dispatch.audit.ts) already records those holds with the
 *    command's own dotted action + arg names — the mapping it alone owns.
 *  - resolve → an `approvals.decide` event (approved / rejected; expiry and
 *    sweep decide as the system actor), same correlation id. The gated action
 *    it decided rides `details.gated_action`.
 *
 * The approved/rejected verdict lives here; a CLI command's replayed execution
 * records its own terminal success/failure through the dispatch adapter, on the
 * same correlation id. Non-CLI holds have no separate execution event in this
 * increment — the request and decision are the durable governance record, which
 * is what survives the pending_approvals row being deleted on resolution.
 *
 * Recording model matches the rest of the log: WHO decided WHAT, never raw
 * payload values — the gated action name and the approval id, not its args.
 */
import { emitAuditEvent } from '../../audit/emit.js';
import { initAuditLog } from '../../audit/init.js';
import type { AuditActor, AuditOrigin, AuditOutcome, AuditResource } from '../../audit/types.js';
import { approvalActionName, channelOf, channelOrigin, containerOrigin } from '../../audit/vocab.js';
import type { PendingApproval, Session } from '../../types.js';
import {
  type ApprovalRequestedEvent,
  type ApprovalResolvedEvent,
  registerApprovalRequestedHandler,
  registerApprovalResolvedHandler,
} from './primitive.js';

// Loading this adapter also boots the audit log when enabled (idempotent — the
// dispatch adapter may have run it already), so the approval surface records
// even on a build that composed it before the CLI middleware.
initAuditLog();

/** The agent group whose action raised the hold, or null for host-raised holds. */
function requesterOf(approval: PendingApproval, session: Session | null): string | null {
  return approval.agent_group_id ?? session?.agent_group_id ?? null;
}

/** The requester as an actor: the agent group, else the host (system-raised). */
function requesterActor(agentGroupId: string | null): AuditActor {
  return agentGroupId ? { type: 'agent', id: agentGroupId } : { type: 'system', id: 'host' };
}

/** Origin of the requesting side: the container session if any, else the host socket. */
function requesterOrigin(session: Session | null): AuditOrigin {
  return session ? containerOrigin(session.id, session.messaging_group_id) : { transport: 'socket' };
}

// request → pending. cli_command holds belong to the dispatch adapter (correct
// dotted action + args); every other gated surface is recorded here.
registerApprovalRequestedHandler((event: ApprovalRequestedEvent) => {
  if (event.approval.action === 'cli_command') return;
  emitAuditEvent(() => {
    const agentGroupId = requesterOf(event.approval, event.session);
    const resources: AuditResource[] = [];
    if (agentGroupId) resources.push({ type: 'agent_group', id: agentGroupId });
    resources.push({ type: 'approval', id: event.approval.approval_id });
    if (event.deliveredTo) resources.push({ type: 'user', id: event.deliveredTo });
    return {
      actor: requesterActor(agentGroupId),
      origin: requesterOrigin(event.session),
      action: approvalActionName(event.approval.action),
      resources,
      outcome: 'pending' as AuditOutcome,
      correlationId: event.approval.approval_id,
    };
  });
});

const RESOLVED_OUTCOME: Record<ApprovalResolvedEvent['outcome'], AuditOutcome> = {
  approve: 'approved',
  reject: 'rejected',
  expire: 'rejected',
  sweep: 'rejected',
};

// resolve → approvals.decide. A human clicker is the actor (answered on a chat
// platform); expiry and startup sweep decide as the system actor.
registerApprovalResolvedHandler((event: ApprovalResolvedEvent) => {
  emitAuditEvent(() => {
    const agentGroupId = requesterOf(event.approval, event.session);
    const bySystem = !event.userId || event.outcome === 'expire' || event.outcome === 'sweep';
    const resources: AuditResource[] = [];
    if (agentGroupId) resources.push({ type: 'agent_group', id: agentGroupId });
    resources.push({ type: 'approval', id: event.approval.approval_id });
    const details: Record<string, unknown> = { gated_action: approvalActionName(event.approval.action) };
    if (agentGroupId) details.requested_by = agentGroupId;
    if (event.outcome === 'expire') details.reason = 'expired';
    if (event.outcome === 'sweep') details.reason = 'swept';
    return {
      actor: bySystem ? { type: 'system', id: 'host' } : { type: 'human', id: event.userId },
      origin: bySystem ? { transport: 'socket' } : channelOrigin(channelOf(event.userId)),
      action: 'approvals.decide',
      resources,
      outcome: RESOLVED_OUTCOME[event.outcome],
      correlationId: event.approval.approval_id,
      details,
    };
  });
});
