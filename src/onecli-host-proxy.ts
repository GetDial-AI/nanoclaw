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
import { setGlobalDispatcher, getGlobalDispatcher, ProxyAgent, type Dispatcher } from 'undici';

import { log } from './log.js';

/** Hosts whose traffic should be routed through the OneCLI gateway. */
const PROXY_HOSTS = ['api.getdial.ai'];

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

  const proxy = new ProxyAgent({
    uri,
    token,
    requestTls: cfg.caCertificate ? { ca: cfg.caCertificate } : undefined,
  });
  // Route ONLY Dial API traffic through the gateway. A blanket global proxy
  // would also send the host's own OneCLI control-plane calls (ensureAgent, on
  // 127.0.0.1) and other local traffic through the gateway and break them, so
  // fall back to the original (direct) dispatcher for everything else.
  const direct = getGlobalDispatcher();
  const hostOf = (origin: string | URL | undefined): string => {
    try {
      return typeof origin === 'string' ? new URL(origin).host : (origin?.host ?? '');
    } catch {
      return '';
    }
  };
  const router = {
    dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandlers) {
      const host = hostOf(opts.origin);
      const useProxy = PROXY_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
      return (useProxy ? proxy : direct).dispatch(opts, handler);
    },
    close: () => proxy.close(),
    destroy: () => proxy.destroy(),
  } as unknown as Dispatcher;
  setGlobalDispatcher(router);
  applied = true;
  log.info('OneCLI host proxy applied — Dial API traffic routes through the gateway (credentials injected)', {
    gateway: uri,
    hosts: PROXY_HOSTS,
  });
  return true;
}
