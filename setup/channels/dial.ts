/**
 * Dial channel flow for setup:auto.
 *
 * `runDialChannel(displayName)`: probe the `dial` CLI → reuse the signed-in
 * account or run signup(email+OTP)+onboard → confirm the auto-provisioned
 * number → install the adapter + dial-cli skill (setup/add-dial.sh) → ensure
 * the `dial listen` daemon → restart the service → PAIR (show a 4-digit code
 * the operator texts to the Dial number; the running adapter consumes it and
 * records the sender as owner) → role prompt → wire the public line.
 *
 * The Dial number is a single PUBLIC, threaded line: one messaging group
 * (platform_id = the number) with each texter as a thread, wired once with
 * unknown_sender_policy 'public' so anyone can reach the agent.
 */
import { spawnSync } from 'child_process';
import path from 'path';

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
  listen?: { running?: boolean };
}

export async function runDialChannel(displayName: string): Promise<void> {
  const cliPath = await ensureDialCli();

  await ensureSignedIn(cliPath);
  const lineNumber = confirmProvisionedNumber(cliPath);

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
  // Register the inbound command target from HERE, not the adapter: the host
  // service runs under launchd/systemd with a limited PATH that often can't
  // find `dial`, so its self-registration fails silently. The wizard has the
  // CLI on PATH — register the handler the adapter just wrote at boot.
  registerCommandTarget(cliPath);

  // WIRING via pairing: show a 4-digit code; the operator texts it to the Dial
  // number from any phone. The running adapter consumes it (recording the
  // sender as owner) before it reaches an agent. This proves control of the
  // sending number without asking them to type it.
  const pairedNumber = await runPairing(lineNumber);

  const role = await askOperatorRole('Dial');
  setupLog.userInput('dial_role', role);
  const agentName = await resolveAgentName();

  // Wire the PUBLIC line: the messaging group's platform_id is the Dial number
  // itself; each texter becomes a thread. The adapter's declared defaults set
  // unknown_sender_policy 'public', so init-first-agent stamps the mg public —
  // everyone can reach the agent, no per-sender approval.
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
      pairedNumber,
      '--platform-id',
      lineNumber || pairedNumber,
      '--display-name',
      displayName,
      '--agent-name',
      agentName,
      '--role',
      role,
    ],
    {
      running: `Connecting ${agentName} to your Dial line…`,
      done: `${agentName} is live on ${lineNumber || 'your Dial number'}.`,
    },
    {
      extraFields: { CHANNEL: 'dial', AGENT_NAME: agentName, PLATFORM_ID: lineNumber || pairedNumber, ROLE: role },
    },
  );
  if (!init.ok) {
    await fail(
      'init-first-agent',
      `Couldn't finish connecting ${agentName}.`,
      'You can retry later with `/manage-channels`.',
    );
  }

  // Optional, Dial-channel-only: offer the Dial container tool so the agent can
  // send SMS / place AI calls from ANY channel it's on — not just receive and
  // reply on this Dial line. The channel onboarding above already wrote the Dial
  // auth file, so the installer registers the OneCLI credential with no extra
  // auth prompt here.
  await offerDialTool();
}

/**
 * Optional add-on, offered only in the Dial channel flow: install the Dial
 * container tool — the `dial` CLI baked into the agent image plus an OneCLI
 * credential — so any agent can text/call from whatever channel it's on, not
 * just this Dial line. The deterministic work lives in the add-dial-tool skill's
 * `add.sh` (reused here); the channel onboarding already wrote the auth file it
 * reads, so no extra sign-in is needed. Non-fatal: the Dial line works either way.
 */
async function offerDialTool(): Promise<void> {
  p.note(
    'Say yes so your assistant can send SMS and make AI calls for you from every channel you use it on — Telegram, WhatsApp, and more.',
    'Add phone superpowers to your assistant?',
  );
  const wants = ensureAnswer(
    await p.confirm({ message: 'Install the Dial tool now?', initialValue: true }),
  ) as boolean;
  setupLog.userInput('dial_tool_optin', String(wants));
  if (!wants) return;

  // The installer registers the credential via OneCLI; without it the CLI still
  // installs but calls would 401. Skip gracefully rather than fail the wizard.
  const hasOnecli = spawnSync('onecli', ['version'], { stdio: 'ignore' }).status === 0;
  if (!hasOnecli) {
    p.note(
      [
        'The Dial tool needs OneCLI to inject credentials, and it isn’t set up yet.',
        'Run /init-onecli, then finish with:',
        k.cyan('  bash .claude/skills/add-dial-tool/add.sh'),
        'Your Dial line still works in the meantime.',
      ].join('\n'),
      'Skipped — OneCLI required',
    );
    setupLog.step('dial-tool', 'skipped', 0, { REASON: 'onecli_missing' });
    return;
  }

  const res = await runQuietChild(
    'dial-tool',
    'bash',
    ['.claude/skills/add-dial-tool/add.sh'],
    {
      running: 'Installing the Dial tool (rebuilding the agent image — this can take a minute)…',
      done: 'Dial tool installed — your assistant can text and call from any channel now.',
    },
  );
  if (!res.ok) {
    p.note(
      ['Couldn’t finish installing the Dial tool — your Dial line still works.', 'Retry later with /add-dial-tool.'].join(
        '\n',
      ),
      'Heads up',
    );
    return;
  }
  if (res.terminal?.fields?.CREDENTIAL !== 'set') {
    p.note(
      'Installed, but no Dial credential was registered — texts/calls may return 401. Re-run `bash .claude/skills/add-dial-tool/add.sh` after signing in with the `dial` CLI.',
      'Almost there',
    );
  }
}

/**
 * Render an SMSTO: URI as terminal-art QR lines. `qrcode` is installed by
 * setup/add-dial.sh (dynamic import so setup-module load doesn't need it).
 * Returns [] on any failure so the caller falls back to the plain code.
 */
async function renderSmsQr(uri: string): Promise<string[]> {
  try {
    const QRCode = await import('qrcode');
    const art = await QRCode.toString(uri, { type: 'terminal', small: true });
    return art.trimEnd().split('\n');
  } catch {
    return [];
  }
}

/**
 * Pairing step: mint a 4-digit code, ask the operator to text it to the Dial
 * number, and wait for the running adapter to consume it (shared JSON file
 * under data/). Returns the paired sender's E.164. Uses a dynamic import
 * because the pairing module ships with the channel (installed by
 * setup/add-dial.sh above), so it doesn't exist at setup-module load time.
 */
async function runPairing(lineNumber: string | null): Promise<string> {
  const { createPairing, waitForPairing } = await import('../../src/channels/dial-pairing.js');
  const rec = await createPairing();
  const target = lineNumber ?? 'your Dial number';

  // Prefer a scannable QR: it encodes an SMSTO: link so the phone camera opens
  // Messages pre-filled with the code + recipient — the operator just taps Send.
  // Falls back to the plain code if there's no number or QR rendering fails.
  const qrLines = lineNumber ? await renderSmsQr(`SMSTO:${lineNumber}:${rec.code}`) : [];
  if (qrLines.length > 0) {
    p.note(
      [
        ...qrLines,
        '',
        `Scan with your phone camera — it opens Messages pre-filled to ${k.bold(target)}.`,
        `Just press ${k.bold('Send')}. (The message is the code ${accentGreen(rec.code)}.)`,
        k.dim(`Can't scan? Text ${rec.code} to ${target} yourself.`),
      ].join('\n'),
      'Scan to pair',
    );
  } else {
    p.note(
      [
        `   ${accentGreen(rec.code.split('').join('  '))}`,
        '',
        `From the phone you want to use, text ${k.bold('only these 4 digits')} to ${k.bold(target)}.`,
        k.dim('This proves the number is yours; you become the owner.'),
      ].join('\n'),
      'Pairing code',
    );
  }
  setupLog.userInput('dial_pairing_code_issued', rec.code);

  const s = p.spinner();
  const start = Date.now();
  s.start('Waiting for your text…');
  try {
    // Cap the wait so setup can't hang forever; the operator can re-run.
    // .unref() so the pending timer never keeps the process alive after a
    // successful pair (otherwise setup hangs at the end until it fires).
    const consumed = await Promise.race([
      waitForPairing(rec.code),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('timeout')), 5 * 60_000).unref();
      }),
    ]);
    const from = consumed.consumed?.fromNumber;
    if (!from) throw new Error('paired but no number recorded');
    s.stop(`Paired with ${accentGreen(from)}. ${k.dim(`(${fmtDuration(Date.now() - start)})`)}`);
    setupLog.step('dial-pair', 'success', Date.now() - start, { PAIRED_NUMBER: from });
    return from;
  } catch (err) {
    const reason = err instanceof Error && err.message === 'timeout' ? 'no code received in time' : String(err);
    s.stop('Pairing didn’t complete.', 1);
    setupLog.step('dial-pair', 'failed', Date.now() - start, { ERROR: reason.slice(0, 120) });
    // fail() returns Promise<never> — control never returns past here.
    return await fail(
      'dial-pair',
      "Didn't receive the pairing code.",
      'Make sure you texted exactly the 4 digits to the Dial number, then re-run setup.',
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

/**
 * Register the adapter's inbound command target from the wizard. The host
 * service's PATH (launchd/systemd) usually can't find `dial`, so the adapter's
 * own boot-time registration fails silently — the wizard has the CLI on PATH,
 * so it registers the handler the adapter wrote at boot. Idempotent.
 */
function registerCommandTarget(cliPath: string): void {
  const handler = path.join(process.cwd(), 'data', 'dial', 'handle-dial-event.sh');
  const listed = runDial(cliPath, ['local-target', 'list', '--json']);
  if (listed.ok && listed.stdout.includes(handler)) return; // already registered
  const res = runDial(cliPath, ['local-target', 'add', 'cmd', handler]);
  setupLog.step(
    'dial-command-target',
    res.ok ? 'success' : 'failed',
    0,
    res.ok ? { HANDLER: handler } : { ERROR: (res.stderr || 'add failed').slice(0, 120) },
  );
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
  numbers?: Array<{ number?: string }>;
}

/** Show + return the account's Dial number (the public line). Null if unreadable. */
function confirmProvisionedNumber(cliPath: string): string | null {
  const list = dialJson<NumberListResponse>(cliPath, ['number', 'list']);
  const numbers = list?.numbers?.map((n) => n.number).filter((n): n is string => !!n) ?? [];
  if (numbers.length === 0) return null; // couldn't read one back; adapter uses the account default
  p.note(
    [`Your agent's public line:`, '', ...numbers.map((n) => `  ${accentGreen(n)}`)].join('\n'),
    'Your Dial number',
  );
  setupLog.step('dial-number', 'success', 0, { NUMBERS: numbers.join(',') });
  return numbers[0];
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
