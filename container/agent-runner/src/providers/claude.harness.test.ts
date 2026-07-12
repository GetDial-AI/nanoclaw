/**
 * Harness-capability mapping in the Claude provider: the disallow list is the
 * fixed set plus capability-driven entries (fail closed), and the PreToolUse
 * hook blocks exactly that list. Pure — no SDK, no DB (the hook's
 * container_state write is try/caught by design).
 */
import { describe, expect, it } from 'bun:test';

import { ClaudeProvider, SDK_DISALLOWED_TOOLS, buildDisallowedTools, createPreToolUseHook } from './claude.js';

type LooseHook = (input: unknown) => Promise<Record<string, unknown>>;

describe('buildDisallowedTools', () => {
  it('fails closed: absent/empty/off/garbage all include Workflow plus the fixed set', () => {
    for (const caps of [undefined, {}, { workflow: 'off' }, { workflow: 'garbage' }]) {
      const list = buildDisallowedTools(caps);
      for (const fixed of SDK_DISALLOWED_TOOLS) expect(list).toContain(fixed);
      expect(list).toContain('Workflow');
      expect(list).toContain('DesignSync');
      expect(list).toContain('ReportFindings');
    }
  });

  it('workflow=on removes only Workflow', () => {
    const list = buildDisallowedTools({ workflow: 'on' });
    expect(list).not.toContain('Workflow');
    expect(list).toContain('DesignSync');
    expect(list).toContain('CronCreate');
  });

  it('agent-teams has no runner mechanism and never changes the list', () => {
    expect(buildDisallowedTools({ 'agent-teams': 'on' })).toEqual(buildDisallowedTools({ 'agent-teams': 'off' }));
  });
});

describe('createPreToolUseHook', () => {
  it('blocks a listed tool, with the redirect in the model-visible fields', async () => {
    const hook = createPreToolUseHook(['Workflow']) as unknown as LooseHook;
    const res = await hook({ tool_name: 'Workflow', tool_input: {} });
    expect(res.decision).toBe('block');
    // The CLI feeds `reason` / permissionDecisionReason back to the model on a
    // deny — stopReason is only surfaced with continue:false (turn-ending).
    expect(String(res.reason)).toContain('nanoclaw equivalent');
    const specific = res.hookSpecificOutput as Record<string, unknown>;
    expect(specific.permissionDecision).toBe('deny');
    expect(String(specific.permissionDecisionReason)).toContain('nanoclaw equivalent');
  });

  it('passes an unlisted tool through', async () => {
    const hook = createPreToolUseHook(['Workflow']) as unknown as LooseHook;
    const res = await hook({ tool_name: 'Bash', tool_input: { timeout: 1000 } });
    expect(res.continue).toBe(true);
  });
});

describe('ClaudeProvider instance wiring', () => {
  // Guards the seam the pure-helper tests can't see: the provider must
  // actually BUILD its blocklist from the capability map it was constructed
  // with (a revert to the static SDK_DISALLOWED_TOOLS constant at the query
  // site would pass every other test in this file).
  it('builds its disallow list and hook blocklist from the constructor capabilities', async () => {
    const off = new ClaudeProvider({ harnessCapabilities: { workflow: 'off' } });
    const on = new ClaudeProvider({ harnessCapabilities: { workflow: 'on' } });

    expect(off['disallowedTools']).toContain('Workflow');
    expect(on['disallowedTools']).not.toContain('Workflow');
    expect(on['disallowedTools']).toContain('DesignSync');

    const offHook = off['preToolUseHook'] as unknown as LooseHook;
    const onHook = on['preToolUseHook'] as unknown as LooseHook;
    expect((await offHook({ tool_name: 'Workflow', tool_input: {} })).decision).toBe('block');
    expect((await onHook({ tool_name: 'Workflow', tool_input: {} })).continue).toBe(true);
  });
});
