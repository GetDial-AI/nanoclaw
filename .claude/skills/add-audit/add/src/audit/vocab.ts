/**
 * Domain-free event vocabulary — actor and origin constructors shared by the
 * domain-owned `*.audit.ts` adapters (the CLI adapter today; approval and
 * channel adapters attach here in later increments). Pure derivation; nothing
 * here writes the log.
 *
 * Leaf rule: this module (like the rest of src/audit/) may depend on node,
 * config/log, shared types, and the db read layer — never on src/cli/* or
 * src/modules/*. Domain-specific mapping (CLI resources, approval payloads)
 * lives in the adapter file of the domain that owns it.
 */
import os from 'os';

import { getMessagingGroup } from '../db/messaging-groups.js';
import type { AuditOrigin } from './types.js';

/**
 * Host callers stamp `host:<install user>` daemon-side: the ncl socket is
 * 0600 and owned by the install user, so the identity is accurate by
 * construction without peer credentials.
 */
export function hostUser(): string {
  try {
    return os.userInfo().username;
    // eslint-disable-next-line no-catch-all/no-catch-all -- os.userInfo throws on exotic hosts; a fallback actor id beats no audit event
  } catch {
    return process.env.USER || 'unknown';
  }
}

export function containerOrigin(sessionId: string, messagingGroupId: string | null): AuditOrigin {
  const origin: AuditOrigin = { transport: 'container', session_id: sessionId };
  if (messagingGroupId) {
    origin.messaging_group_id = messagingGroupId;
    const channel = getMessagingGroup(messagingGroupId)?.channel_type;
    if (channel) origin.channel = channel;
  }
  return origin;
}

/**
 * An approval decision answered on a chat platform (the approver clicked a
 * card). `channelType` is the platform the click came from.
 */
export function channelOrigin(channelType: string | null): AuditOrigin {
  return channelType ? { transport: 'channel', channel: channelType } : { transport: 'channel' };
}

/** Channel of a namespaced `<channel>:<handle>` id, or null if unprefixed. */
export function channelOf(namespacedUserId: string): string | null {
  const i = namespacedUserId.indexOf(':');
  return i > 0 ? namespacedUserId.slice(0, i) : null;
}

/**
 * Dotted governance name for a hold's action, matching the guard catalog
 * (agents.create, self_mod.*, a2a.send, senders.admit, channels.register).
 * An unmapped action falls back to its raw name so a new gated surface still
 * records — uncatalogued, never dropped.
 */
const APPROVAL_ACTION_DOTTED: Record<string, string> = {
  create_agent: 'agents.create',
  install_packages: 'self_mod.install_packages',
  add_mcp_server: 'self_mod.add_mcp_server',
  a2a_message_gate: 'a2a.send',
  sender_admit: 'senders.admit',
  channel_registration: 'channels.register',
  onecli_credential: 'onecli.credential.use',
};

export function approvalActionName(action: string): string {
  return APPROVAL_ACTION_DOTTED[action] ?? action;
}
