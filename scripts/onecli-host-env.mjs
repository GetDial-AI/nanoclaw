/**
 * Emit shell `export` lines that route THIS host process's outbound HTTPS
 * through the OneCLI gateway — the same proxy NanoClaw already applies to agent
 * containers, but for the host itself. Used by bin/host-onecli.sh so channel
 * adapters (e.g. Dial) get their credentials injected by OneCLI instead of
 * reading them from .env / local auth files.
 *
 * OneCLI never returns a raw secret; it injects credentials into outgoing
 * requests at the transport layer. So we fetch the gateway config from the
 * OneCLI SDK, write its CA to a file, and export:
 *   HTTPS_PROXY / HTTP_PROXY  → the OneCLI gateway
 *   NODE_USE_ENV_PROXY=1      → make Node's global fetch honor the proxy
 *   NODE_EXTRA_CA_CERTS       → trust the gateway's MITM CA
 *
 * Prints nothing (exit 0) if OneCLI isn't reachable, so the caller falls back
 * to a normal (non-proxied) start.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  let OneCLI;
  try {
    ({ OneCLI } = await import('@onecli-sh/sdk'));
  } catch {
    return; // SDK not installed — nothing to emit
  }

  const onecli = new OneCLI({
    url: process.env.ONECLI_URL || 'http://127.0.0.1:10254',
    apiKey: process.env.ONECLI_API_KEY || '',
  });

  let cfg;
  try {
    cfg = await onecli.getContainerConfig();
  } catch {
    return; // gateway not up — caller starts without the proxy
  }

  const env = cfg.env || {};
  // The container config targets host.docker.internal; from the host itself the
  // gateway is on loopback.
  const toHost = (v) => (v || '').replace(/host\.docker\.internal/g, '127.0.0.1');
  const httpsProxy = toHost(env.HTTPS_PROXY || env.https_proxy);
  const httpProxy = toHost(env.HTTP_PROXY || env.http_proxy) || httpsProxy;
  if (!httpsProxy) return;

  // Persist the CA so NODE_EXTRA_CA_CERTS can point at a stable path.
  let caPath = env.NODE_EXTRA_CA_CERTS || '';
  if (cfg.caCertificate) {
    caPath = path.join(os.tmpdir(), 'nanoclaw-onecli-host-ca.pem');
    fs.writeFileSync(caPath, cfg.caCertificate);
  }

  const out = [
    `export HTTPS_PROXY=${JSON.stringify(httpsProxy)}`,
    `export https_proxy=${JSON.stringify(httpsProxy)}`,
    `export HTTP_PROXY=${JSON.stringify(httpProxy)}`,
    `export http_proxy=${JSON.stringify(httpProxy)}`,
    `export NODE_USE_ENV_PROXY=1`,
  ];
  if (caPath) out.push(`export NODE_EXTRA_CA_CERTS=${JSON.stringify(caPath)}`);
  process.stdout.write(out.join('\n') + '\n');
}

main().catch(() => {
  /* stay silent so the caller can start normally */
});
