/**
 * Operator-side approval resolution — the host-CLI equivalent of a channel
 * button click.
 *
 * `ncl approvals approve|reject|reject-with-reason` routes through the SAME
 * authorization (`isAuthorizedApprovalClick`) and resolution the click path
 * uses — `handleApprovalsResponse` for approve/plain-reject, `finalizeReject`
 * with an inline reason for reject-with-reason (the operator supplies the reason
 * directly, so the DM prompt-and-capture flow is skipped). Only the ingress
 * differs from a rendered card button.
 *
 * Host-only: an agent can never resolve an approval — that would let it
 * self-approve its own held action. `--as-user` is the approver identity the
 * operator resolves as, checked against the pending row exactly as a click's
 * user id would be. `--as-user` is asserted, not authenticated — which is sound
 * because the ncl socket is owner-only and a host caller already bypasses the
 * approval gate outright.
 */
import { getPendingApproval, getSession } from '../../db/sessions.js';
import { finalizeReject } from '../../modules/approvals/finalize.js';
import { handleApprovalsResponse, isAuthorizedApprovalClick } from '../../modules/approvals/response-handler.js';
import type { ResponsePayload } from '../../response-registry.js';
import type { CallerContext } from '../frame.js';

export type ResolveDecision = 'approve' | 'reject' | 'reject-with-reason';

export interface ResolveResult {
  approval_id: string;
  action: string;
  resolved: 'approve' | 'reject';
  reason?: string;
}

/** Matches reason-capture's cap so an operator reason and a chat reason relay identically. */
const MAX_REASON_LEN = 280;

function clampReason(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length <= MAX_REASON_LEN ? trimmed : trimmed.slice(0, MAX_REASON_LEN - 1) + '…';
}

export async function resolveApprovalFromCli(
  args: Record<string, unknown>,
  ctx: CallerContext,
  decision: ResolveDecision,
): Promise<ResolveResult> {
  if (ctx.caller !== 'host') {
    throw new Error('approvals can only be resolved by an operator (host), not an agent');
  }

  const id = String(args.id ?? '').trim();
  const asUserRaw = String(args.as_user ?? '').trim();
  if (!id) throw new Error('--id is required');
  if (!asUserRaw) throw new Error('--as-user is required (the approver identity, e.g. cli:local)');
  const approver = asUserRaw.includes(':') ? asUserRaw : `cli:${asUserRaw}`;

  const approval = getPendingApproval(id);
  if (!approval) throw new Error(`no pending approval: ${id}`);

  const payload: ResponsePayload = {
    questionId: id,
    value: decision === 'approve' ? 'approve' : 'reject',
    userId: approver,
    channelType: 'cli',
    platformId: '',
    threadId: null,
  };
  if (!isAuthorizedApprovalClick(approval, payload)) {
    throw new Error(
      `${approver} is not authorized to resolve approval ${id} — must be its named approver, or an admin/owner of the requesting agent group`,
    );
  }

  if (decision === 'reject-with-reason') {
    const reason = clampReason(String(args.reason ?? ''));
    if (!reason) throw new Error('--reason is required for reject-with-reason');
    if (!approval.session_id) throw new Error(`approval ${id} has no session to notify`);
    const session = getSession(approval.session_id);
    if (!session) throw new Error(`approval ${id} session not found`);
    await finalizeReject(approval, session, approver, reason);
    return { approval_id: id, action: approval.action, resolved: 'reject', reason };
  }

  // approve / plain reject → the same path a card click drives (handler +
  // grant-carrying replay on approve; finalizeReject on plain reject).
  await handleApprovalsResponse(payload);
  return { approval_id: id, action: approval.action, resolved: decision === 'approve' ? 'approve' : 'reject' };
}
