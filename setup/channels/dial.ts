/**
 * Dial channel flow for setup:auto.
 *
 * `runDialChannel(displayName)` owns the full branch from the `dial` CLI
 * presence check through the welcome SMS:
 *
 *   1. Probe the `dial` CLI on PATH. If missing, print the one-line installer
 *      (curl https://getdial.ai/install | bash) and bail with an actionable
 *      error.
 *   2. `dial doctor --json` — if already signed in, offer to reuse that
 *      account (no email/OTP re-prompt); otherwise collect email → `dial
 *      signup` → OTP → `dial onboard` (which also provisions the first US
 *      number and installs the nanoclaw Dial skill).
 *   3. Confirm the account's auto-provisioned number (`dial number list`).
 *      Provisioning is Dial's own concern — we never ask the operator to pick
 *      or buy a number.
 *   4. Install the adapter via setup/add-dial.sh (idempotent).
 *   5. Wire the CLI command-target handler: ensure the `dial listen` daemon is
 *      installed. The adapter registers the actual command target on its next
 *      boot, so the service restart in step 6 completes the wiring.
 *   6. Kick the service so the adapter picks up the Dial credentials and
 *      registers its command target.
 *   7. Ask operator role, the phone they'll text from, and the agent name.
 *   8. Wire the agent via scripts/init-first-agent.ts; the existing welcome
 *      path delivers the greeting through the adapter (an SMS to their phone).
 *
 * Dial has no group chats: every conversation is a 1:1 exchange between the
 * account's number and a remote number, so the operator's own phone is both
 * the user handle and the DM platform id. Ownership is established by the Dial
 * account auth (they signed up / signed in), so — unlike Telegram — there is
 * no pairing handshake.
 *
 * Output obeys the three-level contract: clack UI for the user, structured
 * entries in logs/setup.log, full raw output in per-step files under
 * logs/setup-steps/. See docs/setup-flow.md.
 */
import { spawnSync } from 'child_process';

import * as p from '@clack/prompts';
import k from 'kleur';

import * as setupLog from '../logs.js';
import { getLaunchdLabel, getSystemdUnit } from '../../src/install-slug.js';
import { ensureAnswer, fail, runQuietChild } from '../lib/runner.js';
import { askOperatorRole } from '../lib/role-prompt.js';
import { accentGreen, fmtDuration } from '../lib/theme.js';

const DEFAULT_AGENT_NAME = 'Nano';
const DEFAULT_INBOUND_INSTRUCTION =
  'You are a friendly AI receptionist answering calls to this number. Greet the caller, ask how you can help, and take a clear message — their name, number, and reason for calling — if you cannot help directly.';

interface DoctorReport {
  auth?: { signedIn?: boolean; email?: string };
  listen?: { installed?: boolean; running?: boolean };
  nextStep?: string;
}

export async function runDialChannel(displayName: string): Promise<void> {
  const cliPath = await ensureDialCli();

  await ensureSignedIn(cliPath);
  confirmProvisionedNumber(cliPath);

  const install = await runQuietChild('dial-install', 'bash', ['setup/add-dial.sh'], {
    running: 'Installing the Dial adapter…',
    done: 'Dial adapter installed.',
    skipped: 'Dial adapter already installed.',
  });
  if (!install.ok) {
    await fail(
      'dial-install',
      "Couldn't install the Dial adapter.",
      'See logs/setup-steps/ for details, then retry setup.',
    );
  }

  ensureListenDaemon(cliPath);
  await restartService();

  const role = await askOperatorRole('Dial');
  setupLog.userInput('dial_role', role);

  const operatorPhone = await askOperatorPhone();
  const agentName = await resolveAgentName();

  const init = await runQuietChild(
    'init-first-agent',
    'pnpm',
    [
      'exec',
      'tsx',
      'scripts/init-first-agent.ts',
      '--channel',
      'dial',
      '--user-id',
      operatorPhone,
      '--platform-id',
      operatorPhone,
      '--display-name',
      displayName,
      '--agent-name',
      agentName,
      '--role',
      role,
    ],
    {
      running: `Connecting ${agentName} to Dial…`,
      done: `${agentName} is ready. Check your phone for a welcome text.`,
    },
    {
      extraFields: { CHANNEL: 'dial', AGENT_NAME: agentName, PLATFORM_ID: operatorPhone, ROLE: role },
    },
  );
  if (!init.ok) {
    await fail(
      'init-first-agent',
      `Couldn't finish connecting ${agentName}.`,
      'You can retry later with `/manage-channels`.',
    );
  }
}

// ---------------------------------------------------------------------------
// dial CLI helpers
// ---------------------------------------------------------------------------

function dialCliPath(): string {
  return process.env.DIAL_CLI_PATH || 'dial';
}

/** Run a `dial` command, capturing output. Never throws. */
function runDial(cliPath: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const res = spawnSync(cliPath, args, { encoding: 'utf8' });
  return {
    ok: !res.error && res.status === 0,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

/** Run a `dial … --json` command and parse the first JSON object in stdout. */
function dialJson<T>(cliPath: string, args: string[]): T | null {
  const res = runDial(cliPath, [...args, '--json']);
  if (!res.stdout.trim()) return null;
  try {
    return JSON.parse(res.stdout) as T;
  } catch {
    return null;
  }
}

async function ensureDialCli(): Promise<string> {
  const cliPath = dialCliPath();
  const probe = spawnSync(cliPath, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (!probe.error && probe.status === 0) return cliPath;

  p.note(
    [
      "NanoClaw talks to Dial through the `dial` CLI, which isn't installed yet.",
      '',
      'Install it in another terminal:',
      '',
      k.cyan('  curl -fsSL https://getdial.ai/install | bash'),
      '',
      'Then re-run setup.',
    ].join('\n'),
    'dial CLI not found',
  );
  // fail() returns Promise<never> — control never returns past here.
  await fail('dial-install', 'The `dial` CLI is required but not installed.', 'Install it and re-run setup.');
  throw new Error('unreachable');
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function ensureSignedIn(cliPath: string): Promise<void> {
  const doctor = dialJson<DoctorReport>(cliPath, ['doctor']);
  if (doctor?.auth?.signedIn) {
    const email = doctor.auth.email ?? 'this account';
    const reuse = ensureAnswer(
      await p.confirm({
        message: `You're already signed in to Dial as ${accentGreen(email)}. Reuse this account?`,
        initialValue: true,
      }),
    ) as boolean;
    setupLog.userInput('dial_reuse_account', String(reuse));
    if (reuse) {
      // Signed in already — no verification needed; onboard just (re)installs
      // the nanoclaw Dial skill so the agent can drive the CLI.
      runDial(cliPath, ['onboard', '--agent', 'nanoclaw']);
      return;
    }
  }

  await signUpFlow(cliPath);
}

async function signUpFlow(cliPath: string): Promise<void> {
  const email = ensureAnswer(
    await p.text({
      message: "What's your email? Dial sends a one-time code to verify it.",
      validate: (v) => {
        const t = (v ?? '').trim();
        if (!t) return 'Email is required';
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t)) return "That doesn't look like an email address";
        return undefined;
      },
    }),
  ) as string;
  const trimmedEmail = email.trim();
  setupLog.userInput('dial_email', trimmedEmail);

  const s = p.spinner();
  s.start('Sending your verification code…');
  const signup = runDial(cliPath, ['signup', trimmedEmail, '--force']);
  if (!signup.ok) {
    s.stop("Couldn't request a code.", 1);
    await fail(
      'dial-signup',
      "Dial wouldn't send a verification code.",
      (signup.stderr || 'Check the address and try setup again.').trim(),
    );
  }
  s.stop(`Code sent to ${accentGreen(trimmedEmail)}. Check your inbox.`);

  const code = ensureAnswer(
    await p.text({
      message: 'Enter the 6-digit code from your email',
      validate: (v) => {
        const t = (v ?? '').trim();
        if (!/^\d{6}$/.test(t)) return 'The code is 6 digits';
        return undefined;
      },
    }),
  ) as string;

  const s2 = p.spinner();
  const start = Date.now();
  s2.start('Verifying and provisioning your number…');
  const onboard = runDial(cliPath, [
    'onboard',
    '--code',
    code.trim(),
    '--inbound-instruction',
    DEFAULT_INBOUND_INSTRUCTION,
    '--agent',
    'nanoclaw',
  ]);
  if (!onboard.ok) {
    s2.stop('Verification failed.', 1);
    setupLog.step('dial-onboard', 'failed', Date.now() - start, {
      ERROR: (onboard.stderr || 'onboard failed').slice(0, 200),
    });
    await fail(
      'dial-onboard',
      "Dial couldn't verify that code.",
      'The code may have expired. Re-run setup to get a fresh one.',
    );
  }
  s2.stop(`Signed in and ready. ${k.dim(`(${fmtDuration(Date.now() - start)})`)}`);
  setupLog.step('dial-onboard', 'success', Date.now() - start, {});
}

// ---------------------------------------------------------------------------
// Number + listen daemon
// ---------------------------------------------------------------------------

interface NumberListResponse {
  numbers?: Array<{ number?: string; nickname?: string | null }>;
}

function confirmProvisionedNumber(cliPath: string): void {
  const list = dialJson<NumberListResponse>(cliPath, ['number', 'list']);
  const numbers = list?.numbers?.map((n) => n.number).filter((n): n is string => !!n) ?? [];
  if (numbers.length === 0) {
    p.note(
      "Dial usually provisions a US number automatically at signup. Couldn't read one back just now — the adapter will still use whatever number your account has. You can check with `dial number list`.",
      'Your Dial number',
    );
    return;
  }
  p.note(
    [
      'Your agent will send and receive from:',
      '',
      ...numbers.map((n) => `  ${accentGreen(n)}`),
      '',
      k.dim('Provisioned by Dial at signup — nothing to configure here.'),
    ].join('\n'),
    'Your Dial number',
  );
  setupLog.step('dial-number', 'success', 0, { NUMBERS: numbers.join(',') });
}

function ensureListenDaemon(cliPath: string): void {
  const doctor = dialJson<DoctorReport>(cliPath, ['doctor']);
  if (doctor?.listen?.running) return;

  const s = p.spinner();
  s.start('Setting up inbound event delivery…');
  const res = runDial(cliPath, ['listen', 'install']);
  if (res.ok) {
    s.stop('Inbound events wired up.');
    setupLog.step('dial-listen', 'success', 0, {});
  } else {
    // Non-fatal: some sandboxes/CI have no user service supervisor. Inbound
    // still works once the daemon is started manually; outbound is unaffected.
    s.stop('Inbound daemon not started automatically.', 1);
    p.note(
      [
        "Couldn't start the Dial listen daemon automatically (this needs a user",
        'service supervisor — launchd/systemd). Outbound texts and calls work',
        'regardless. To receive inbound texts, run this once, then restart NanoClaw:',
        '',
        k.cyan('  dial listen install'),
      ].join('\n'),
      'Heads up',
    );
    setupLog.step('dial-listen', 'failed', 0, { ERROR: (res.stderr || 'listen install failed').slice(0, 200) });
  }
}

// ---------------------------------------------------------------------------
// Service restart + prompts
// ---------------------------------------------------------------------------

async function restartService(): Promise<void> {
  const s = p.spinner();
  s.start('Restarting NanoClaw so it sees your Dial credentials…');
  const start = Date.now();
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      spawnSync('launchctl', ['kickstart', '-k', `gui/${process.getuid?.() ?? 501}/${getLaunchdLabel()}`], {
        stdio: 'ignore',
      });
    } else if (platform === 'linux') {
      const unit = getSystemdUnit();
      const user = spawnSync('systemctl', ['--user', 'restart', unit], { stdio: 'ignore' });
      if (user.status !== 0) {
        spawnSync('sudo', ['systemctl', 'restart', unit], { stdio: 'ignore' });
      }
    }
    // Give the adapter a moment to reconnect and register its command target
    // before init-first-agent's welcome SMS hits the delivery path.
    await new Promise((r) => setTimeout(r, 5000));
    s.stop(`NanoClaw restarted. ${k.dim(`(${fmtDuration(Date.now() - start)})`)}`);
    setupLog.step('dial-restart', 'success', Date.now() - start, { PLATFORM: platform });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    s.stop(`Restart may have failed: ${message}`, 1);
    setupLog.step('dial-restart', 'failed', Date.now() - start, { ERROR: message });
    // Non-fatal — the user can restart manually if init-first-agent fails.
  }
}

async function askOperatorPhone(): Promise<string> {
  p.note(
    [
      'What phone number will you text your assistant from?',
      '',
      '  • Use full international format, starting with +',
      '',
      k.dim('Example: +14155551234'),
    ].join('\n'),
    'Your phone number',
  );
  const answer = ensureAnswer(
    await p.text({
      message: 'Your phone number',
      validate: (v) => {
        const t = (v ?? '').trim();
        if (!t) return 'Phone number is required';
        if (!/^\+[1-9]\d{6,14}$/.test(t)) return 'Use E.164 format, e.g. +14155551234';
        return undefined;
      },
    }),
  ) as string;
  const phone = answer.trim();
  setupLog.userInput('dial_operator_phone', phone);
  return phone;
}

async function resolveAgentName(): Promise<string> {
  const preset = process.env.NANOCLAW_AGENT_NAME?.trim();
  if (preset) {
    setupLog.userInput('agent_name', preset);
    return preset;
  }
  const answer = ensureAnswer(
    await p.text({
      message: `What should your ${accentGreen('assistant')} be called?`,
      placeholder: DEFAULT_AGENT_NAME,
      defaultValue: DEFAULT_AGENT_NAME,
    }),
  ) as string;
  const value = answer.trim() || DEFAULT_AGENT_NAME;
  setupLog.userInput('agent_name', value);
  return value;
}
