/**
 * Route the host's own outbound HTTPS through the OneCLI gateway, so channel
 * adapters running in the host process (e.g. Dial in NANOCLAW_DIAL_ONECLI mode)
 * get their credentials injected by OneCLI instead of reading raw keys from
 * .env / local auth files.
 *
 * NanoClaw already routes agent *containers* through the gateway (via env the
 * container runner sets). The host is different: Node's global `fetch` (undici)
 * does NOT honor `HTTPS_PROXY` on Node 22 (`NODE_USE_ENV_PROXY` is Node 24+), so
 * we install an undici `ProxyAgent` dispatcher explicitly, trusting the
 * gateway's CA. The gateway then injects (and overrides) the Authorization
 * header for matching host patterns — verified against api.getdial.ai.
 *
 * Opt-in and best-effort: if OneCLI isn't reachable it logs and leaves the host
 * on a direct connection, so nothing breaks when the flag isn't set.
 */
import { setGlobalDispatcher, ProxyAgent } from 'undici';

import { log } from './log.js';

let applied = false;

export async function applyOneCliHostProxy(): Promise<boolean> {
  if (applied) return true;

  let OneCLI: typeof import('@onecli-sh/sdk').OneCLI;
  try {
    ({ OneCLI } = await import('@onecli-sh/sdk'));
  } catch {
    log.warn('OneCLI host proxy: @onecli-sh/sdk not installed — skipping');
    return false;
  }

  const onecli = new OneCLI({
    url: process.env.ONECLI_URL || 'http://127.0.0.1:10254',
    apiKey: process.env.ONECLI_API_KEY || '',
  });

  let cfg;
  try {
    cfg = await onecli.getContainerConfig();
  } catch (err) {
    log.warn('OneCLI host proxy: gateway not reachable — host stays on a direct connection', {
      err: String(err),
    });
    return false;
  }

  // The container config targets host.docker.internal; from the host itself the
  // gateway is on loopback.
  const raw = (cfg.env.HTTPS_PROXY || cfg.env.https_proxy || '').replace(/host\.docker\.internal/g, '127.0.0.1');
  const m = raw.match(/^https?:\/\/([^:@/]+):([^@/]+)@(.+)$/);
  if (!m) {
    log.warn('OneCLI host proxy: no usable gateway proxy URL in container config — skipping');
    return false;
  }
  const uri = `http://${m[3]}`;
  const token = 'Basic ' + Buffer.from(`${m[1]}:${m[2]}`).toString('base64');

  setGlobalDispatcher(
    new ProxyAgent({
      uri,
      token,
      requestTls: cfg.caCertificate ? { ca: cfg.caCertificate } : undefined,
    }),
  );
  applied = true;
  log.info('OneCLI host proxy applied — host outbound routes through the gateway (credentials injected)', {
    gateway: uri,
  });
  return true;
}
