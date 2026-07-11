/**
 * Boot-time guard sanity — the one cross-registry invariant left to check
 * after all import-time registrations have run.
 *
 * The old registry walk is gone: everything it detected is now
 * unconstructible at the API level.
 *   - A consult site cannot name a missing catalog entry — guard() takes the
 *     GuardedAction VALUE returned by defineGuardedAction, so a dropped
 *     module-edge import or a typo'd action is a compile error (and a forged
 *     value is denied at runtime), not a silent allow.
 *   - A privileged handler cannot register unguarded by omission — the
 *     delivery-action registry requires a guard spec or an explicit
 *     unguarded(<reason>) declaration, and every ncl command derives its
 *     guard inside register().
 *
 * What remains is completeness ACROSS registries: a guarded action that
 * holds via `approvalAction` needs a registered approval handler, or an
 * approved card resolves into nothing — the hold has no continuation. That
 * pairing only exists once every module has loaded (catalog entries and
 * approval handlers register from different modules), so it stays a boot
 * check with the fail-closed posture: the host refuses to start, surfacing
 * the mis-composition at skill-install time instead of at the first
 * approved card.
 */
import { listGuardedActions } from './guard/index.js';
import { log } from './log.js';
import { getApprovalHandler } from './modules/approvals/primitive.js';

/** Holding actions with no approve continuation. Empty = conformant. */
export function grantContinuationGaps(): string[] {
  return listGuardedActions()
    .filter((spec) => spec.approvalAction && !getApprovalHandler(spec.approvalAction))
    .map(
      (spec) =>
        `guarded action "${spec.action}" holds via approval action "${spec.approvalAction}" ` +
        'but no approval handler is registered — an approved hold would have no continuation',
    );
}

/**
 * Boot check: refuse to start when a holding action has no continuation.
 * Call after all import-time registrations (any point in main()).
 */
export function enforceGuardConformance(): void {
  const gaps = grantContinuationGaps();
  if (gaps.length === 0) return;

  console.error(
    [
      '',
      '='.repeat(64),
      'NanoClaw stopped: guard conformance failure',
      '='.repeat(64),
      'A guarded action can hold for approval, but no approval handler is',
      'registered for its approval action — an admin could click Approve',
      'and nothing would execute. This usually means a module (or skill)',
      'defined a holding baseline without registering its continuation.',
      '',
      ...gaps.map((g) => `  - ${g}`),
      '',
      'Register the approval handler (registerApprovalHandler) in the same',
      'module that defines the guarded action, or drop approvalAction from',
      'the definition if the action can never hold.',
      '='.repeat(64),
      '',
    ].join('\n'),
  );
  log.error('Guard conformance failure — refusing to start', { gaps });
  process.exit(1);
}
