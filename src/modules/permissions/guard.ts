/**
 * Permissions guard adapter — the module's catalog entries, composed at the
 * module edge (imported by ./index.ts).
 *
 * senders.admit — the `unknown_sender_policy` switch moved verbatim out of
 * handleUnknownSender: `public` allows (short-circuited before the gate
 * anyway), `request_approval` holds, `strict` denies. The hold is executed by
 * the caller through the module's own pending_sender_approvals flow (card,
 * in-flight dedup) — not the approvals primitive — so this entry has no
 * approvalAction: the approve continuation adds the member and replays
 * routeInbound, which then passes the gate structurally via membership, no
 * grant needed.
 *
 * channels.register — click/reply authorization for the channel-registration
 * flow, verbatim from today's response handler: the delivered approver, or an
 * admin of the pending row's anchor agent group. Consulted by the wrapped
 * response handler (card clicks) and the wrapped name-capture interceptor
 * (free-text replies), so a privilege revoked mid-flow is re-checked at each
 * step.
 */
import { ALLOW, DENY, HOLD, registerGuardedAction } from '../../guard/index.js';
import { getPendingChannelApproval } from './db/pending-channel-approvals.js';
import { hasAdminPrivilege } from './db/user-roles.js';

registerGuardedAction({
  action: 'senders.admit',
  baseline: (input) => {
    const policy = input.payload.policy;
    if (policy === 'public') return ALLOW('public messaging group');
    if (policy === 'request_approval') {
      return HOLD(
        `unknown sender requires admin approval on messaging group ${String(input.payload.messagingGroupId)}`,
      );
    }
    return DENY('unknown sender on a strict messaging group');
  },
});

registerGuardedAction({
  action: 'channels.register',
  baseline: (input) => {
    if (input.actor.kind !== 'human') return DENY('channel registration resolves via human clicks/replies');
    const questionId = typeof input.payload.questionId === 'string' ? input.payload.questionId : '';
    const row = getPendingChannelApproval(questionId);
    if (!row) return DENY(`no pending channel registration for ${questionId || '(missing questionId)'}`);
    if (
      input.actor.userId &&
      (input.actor.userId === row.approver_user_id || hasAdminPrivilege(input.actor.userId, row.agent_group_id))
    ) {
      return ALLOW('delivered approver or anchor-group admin');
    }
    return DENY('not an eligible channel-registration approver');
  },
});
