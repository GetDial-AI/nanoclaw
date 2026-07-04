/**
 * Module-approval timeout sweep.
 *
 * Module approvals (create_agent, install_packages, add_mcp_server, …) are
 * created with a `status='pending'` row and a ~7-day `expires_at` (see
 * MODULE_APPROVAL_TIMEOUT_MS in primitive.ts). If the card is never answered —
 * or its delivery silently fell on the floor — the row would otherwise live
 * forever and permanently block the requesting agent behind an unresolved
 * approval. This sweep, run once per host-sweep tick, finalizes any such row
 * as a timeout via the shared finalize path so the agent always gets a
 * decision.
 *
 * Scope: `getExpiredPendingApprovals` filters to session-scoped rows, so
 * session-less OneCLI credential approvals (resolved in-memory by the gateway
 * callback) are never touched here even though they carry their own expiry.
 */
import { deletePendingApproval, getExpiredPendingApprovals, getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { finalizeTimeout } from './finalize.js';

/**
 * Host-sweep finalizer: any module approval whose expiry elapsed is finalized
 * as a timeout. Called once per sweep tick.
 */
export async function sweepExpiredModuleApprovals(): Promise<void> {
  const rows = getExpiredPendingApprovals(new Date().toISOString());
  for (const approval of rows) {
    const session = approval.session_id ? getSession(approval.session_id) : null;
    if (!session) {
      // The requesting session is gone — nothing to notify; just drop the row.
      deletePendingApproval(approval.approval_id);
      continue;
    }
    await finalizeTimeout(approval, session);
  }
}
