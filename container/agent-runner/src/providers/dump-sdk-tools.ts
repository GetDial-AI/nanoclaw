/**
 * Regenerates sdk-tools-baseline.json — the bare SDK tool-surface fixture
 * asserted by claude.tools.test.ts.
 *
 * Must run INSIDE the agent container image (the pinned CLI binary only
 * exists there). From the repo root:
 *
 *   docker run --rm --network none \
 *     -v "$PWD/container/agent-runner/src":/app/src:ro \
 *     --entrypoint bun <nanoclaw-agent image> /app/src/providers/dump-sdk-tools.ts \
 *     > container/agent-runner/src/providers/sdk-tools-baseline.json
 *
 * MEASURED NONDETERMINISM on the pinned CLI (2.1.197): across query
 * invocations with byte-identical options — even inside one process — (a)
 * conditional tools (Glob, Grep) flicker in and out of the surface, and (b)
 * `disallowedTools` sometimes strips flag-gated tools (Workflow, DesignSync,
 * EnterWorktree) and sometimes ignores them entirely; each single query is
 * internally coherent. Consequences: schema-stripping via disallowedTools is
 * BEST-EFFORT — the deterministic enforcement is the runner's PreToolUse
 * hook, which blocks the invocation regardless of whether the schema shipped.
 *
 * Because the variance is per-query, a single capture pair cannot isolate the
 * allowlist's effect. So: ROUNDS interleaved captures per mode (allowlist /
 * bare), then split each mode into its STABLE core (tools present in every
 * capture of that mode) and the VARIANT set (present in some but not all
 * captures across both modes):
 *   - `tools`        : stable core WITH the production TOOL_ALLOWLIST.
 *   - `toolsBare`    : stable core with no allowedTools.
 *   - `variantTools` : the flicker set, recorded for membership checks.
 *   - `toolsDisallowProbe` : one capture with disallowedTools=[DISALLOW_PROBE]
 *     — a diagnostic of which disallow behavior this regen observed (no test
 *     asserts stripping; a fixed assertion on a nondeterministic mechanism
 *     would be a coin-flip).
 * The drift test asserts tools === toolsBare on the STABLE cores: no allowlist
 * effect has ever been observed there, so the list is permission-layer only
 * (moot under bypassPermissions). If a CLI/SDK bump makes the allowlist shape
 * the surface, the stable cores diverge across every round by construction
 * and the assertion fails deterministically instead of flaking.
 *
 * Agent-teams is enabled via a temp settings.json (wire-verified: settings
 * env strictly beats SDK options env).
 *
 * Zero API traffic: ANTHROPIC_BASE_URL points at an in-process stub answering
 * 401; the full tools array rides on the first /v1/messages request, captured
 * before the run dies on the auth error. The fixture records WIRE tool names
 * (the SDK init message reports legacy aliases, e.g. `Task` for wire `Agent` —
 * do not swap this to an init capture).
 */
import { execFileSync } from 'child_process';
import fs from 'fs';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { TOOL_ALLOWLIST } from './claude.js';

let requests: string[] = [];
let captured: (() => void) | null = null;

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = await req.text();
    if (url.pathname.includes('/messages')) {
      requests.push(body);
      captured?.();
    }
    return new Response(
      JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'fixture-capture-stub' } }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    );
  },
});

const HOME = '/tmp/dump-sdk-tools-home';
const CWD = '/tmp/dump-sdk-tools-ws';
fs.mkdirSync(`${HOME}/.claude`, { recursive: true });
fs.mkdirSync(CWD, { recursive: true });
fs.writeFileSync(
  `${HOME}/.claude/settings.json`,
  JSON.stringify({ env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' } }, null, 2),
);

/**
 * Diagnostic probe for disallowedTools: a flag-gated tool whose stripping is
 * nondeterministic on the current pin (see header). The fixture records what
 * this regen run observed; future pins can be compared against it.
 */
export const DISALLOW_PROBE = 'Workflow';

/** Run one capture and return the sorted wire tool names. */
async function capture(opts?: { allowedTools?: string[]; disallowedTools?: string[] }): Promise<string[]> {
  requests = [];
  const firstRequest = new Promise<void>((resolve) => {
    captured = resolve;
  });
  const q = query({
    prompt: 'fixture capture: reply with one word',
    options: {
      cwd: CWD,
      pathToClaudeCodeExecutable: '/pnpm/claude',
      systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const },
      env: {
        ...process.env,
        HOME,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
        ANTHROPIC_API_KEY: 'fixture-dummy-key',
        ANTHROPIC_AUTH_TOKEN: undefined,
      },
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['user'],
      ...(opts?.allowedTools ? { allowedTools: opts.allowedTools } : {}),
      ...(opts?.disallowedTools ? { disallowedTools: opts.disallowedTools } : {}),
    },
  });
  void (async () => {
    try {
      for await (const _m of q) {
        /* drain until the auth error kills the run */
      }
    } catch {
      /* expected: 401 from the stub */
    }
  })();
  await Promise.race([firstRequest, Bun.sleep(75_000)]);
  await Bun.sleep(1_500); // let retries land so we can pick the largest body
  if (requests.length === 0) {
    console.error('[dump-sdk-tools] no /v1/messages request captured');
    process.exit(1);
  }
  const biggest = requests.reduce((a, b) => (b.length > a.length ? b : a));
  const parsed = JSON.parse(biggest) as { tools?: Array<{ name: string }> };
  return [...new Set((parsed.tools ?? []).map((t) => t.name))].sort();
}

// Interleaved so a drifting gate state biases both modes equally (see header).
const ROUNDS = 3;
const withRuns: string[][] = [];
const bareRuns: string[][] = [];
for (let i = 0; i < ROUNDS; i++) {
  withRuns.push(await capture({ allowedTools: TOOL_ALLOWLIST }));
  bareRuns.push(await capture());
}
const toolsDisallowProbe = await capture({ disallowedTools: [DISALLOW_PROBE] });

const stable = (runs: string[][]): string[] => runs[0].filter((t) => runs.every((r) => r.includes(t))).sort();
const union = (runs: string[][]): Set<string> => new Set(runs.flat());

const tools = stable(withRuns);
const toolsBare = stable(bareRuns);
const stableSet = new Set([...tools, ...toolsBare]);
const variantTools = [...union([...withRuns, ...bareRuns])].filter((t) => !stableSet.has(t)).sort();

const cliVersionRaw = execFileSync('/pnpm/claude', ['--version'], { encoding: 'utf8' }).trim();
const cliVersion = cliVersionRaw.split(/\s+/)[0];
const sdkVersion = (
  JSON.parse(fs.readFileSync('/app/node_modules/@anthropic-ai/claude-agent-sdk/package.json', 'utf8')) as {
    version: string;
  }
).version;

console.log(
  JSON.stringify(
    {
      cliVersion,
      sdkVersion,
      capturedAt: new Date().toISOString(),
      capture: `wire names; stable cores over ${ROUNDS} interleaved rounds per mode (tools=production allowlist, toolsBare=no allowedTools); variantTools=flicker set; toolsDisallowProbe=single capture with disallowedTools:[probe]; teams on`,
      rounds: ROUNDS,
      disallowProbe: DISALLOW_PROBE,
      tools,
      toolsBare,
      variantTools,
      toolsDisallowProbe,
    },
    null,
    2,
  ),
);
process.exit(0);
