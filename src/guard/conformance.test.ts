/**
 * Guard conformance — the boot invariant, checked with the real registries.
 *
 * The old registry walk is gone: an unmapped consult or an undeclared
 * unguarded registration is now unconstructible — guard() takes the defined
 * GuardedAction value (a dropped module-edge import or typo'd name is a
 * compile error), and every registry requires a guard spec or an explicit
 * unguarded(<reason>) declaration. What's left to verify structurally is the
 * cross-registry pairing the compiler can't see: every holding action has a
 * registered approve continuation. The check runs here in CI and at every
 * boot (enforceGuardConformance refuses to start) — CI can't see
 * skill-installed registrations, the boot check can.
 */
import { describe, expect, it } from 'vitest';

// Production barrels — side-effect imports populate the real registries.
import '../cli/commands/index.js';
import '../modules/index.js';
import '../cli/delivery-action.js';
import '../cli/dispatch.js'; // registers the cli_command approval handler

import { commandGuard, listCommands } from '../cli/registry.js';
import { grantContinuationGaps } from '../guard-conformance.js';
import { getApprovalHandler } from '../modules/approvals/primitive.js';
import { defineGuardedAction, listGuardedActions } from './guard-actions.js';
import { HOLD } from './types.js';

describe('guard conformance', () => {
  it('the grant-continuation check (shared with the boot check) reports zero gaps', () => {
    expect(grantContinuationGaps()).toEqual([]);
  });

  it('every holding action pairs with a registered approval handler', () => {
    const holding = listGuardedActions().filter((spec) => spec.approvalAction);
    expect(holding.length).toBeGreaterThan(0);

    const dangling = holding.filter((spec) => !getApprovalHandler(spec.approvalAction as string));
    expect(dangling.map((s) => s.action)).toEqual([]);
  });

  it('every mutating ncl command derives a guard that holds via cli_command', () => {
    const mutating = listCommands().filter((cmd) => cmd.access === 'approval');
    expect(mutating.length).toBeGreaterThan(0);

    const wrong = mutating.filter((cmd) => commandGuard(cmd.name).approvalAction !== 'cli_command');
    expect(wrong.map((c) => c.name)).toEqual([]);
  });

  it('the domain catalog entries are defined once the module barrels load', () => {
    const actions = new Set(listGuardedActions().map((s) => s.action));
    for (const expected of [
      'agents.create',
      'a2a.send',
      'self_mod.install_packages',
      'self_mod.add_mcp_server',
      'senders.admit',
      'channels.register',
    ]) {
      expect(actions.has(expected), `catalog is missing "${expected}"`).toBe(true);
    }
  });

  it('defining the same action twice throws — names are the catalog key', () => {
    defineGuardedAction({ action: 'test.dup-define', baseline: () => HOLD('x') });
    expect(() => defineGuardedAction({ action: 'test.dup-define', baseline: () => HOLD('x') })).toThrow(
      /already defined/,
    );
  });

  // KEEP LAST: defines a holding action with no continuation into the shared
  // per-worker catalog, so every gap check after this point sees it.
  it('the check names a holding action with no approve continuation (what boot refuses on)', () => {
    defineGuardedAction({
      action: 'test.dangling-hold',
      approvalAction: 'test_dangling_hold_approved',
      baseline: () => HOLD('always'),
    });

    const gaps = grantContinuationGaps();
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('test.dangling-hold');
    expect(gaps[0]).toContain('no approval handler');
  });
});
