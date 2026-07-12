import { registerResource } from '../crud.js';
import { resolveApprovalFromCli } from './approvals-resolve.js';

registerResource({
  name: 'approval',
  plural: 'approvals',
  table: 'pending_approvals',
  description:
    'Pending approval — in-flight approval cards waiting for an admin response. Created by requestApproval() (self-mod install_packages/add_mcp_server) and OneCLI credential approval flow. Rows are deleted after the admin approves/rejects or the request expires.',
  idColumn: 'approval_id',
  columns: [
    {
      name: 'approval_id',
      type: 'string',
      description: 'Unique approval identifier (also used as the card questionId).',
    },
    {
      name: 'session_id',
      type: 'string',
      description: 'Session that requested the approval. Null for OneCLI credential approvals.',
    },
    {
      name: 'request_id',
      type: 'string',
      description: 'Original request identifier (OneCLI request UUID or same as approval_id).',
    },
    {
      name: 'action',
      type: 'string',
      description:
        'Action type — matches the registered approval handler (e.g. install_packages, add_mcp_server, onecli_credential).',
    },
    { name: 'payload', type: 'json', description: 'JSON payload carried through to the approval handler.' },
    { name: 'created_at', type: 'string', description: 'Auto-set.' },
    { name: 'agent_group_id', type: 'string', description: 'Originating agent group.' },
    { name: 'channel_type', type: 'string', description: 'Channel the approval card was delivered on.' },
    { name: 'platform_id', type: 'string', description: 'Platform chat ID the card was delivered to.' },
    {
      name: 'platform_message_id',
      type: 'string',
      description: 'Platform message ID of the delivered card (for editing on expiry).',
    },
    { name: 'expires_at', type: 'string', description: 'When this approval expires (OneCLI gateway TTL).' },
    {
      name: 'status',
      type: 'string',
      description: 'Current status.',
      enum: ['pending', 'approved', 'rejected', 'expired'],
    },
    { name: 'title', type: 'string', description: 'Card title shown to the admin.' },
    { name: 'options_json', type: 'json', description: 'Card button options as JSON array.' },
  ],
  operations: { list: 'open', get: 'open' },
  // Operator resolution verbs — the host-CLI equivalent of a channel button
  // click. Host-only (enforced in resolveApprovalFromCli); an agent can never
  // resolve an approval. Same auth + resolution as a real click.
  customOperations: {
    approve: {
      access: 'open',
      description:
        'Approve a pending approval and run its action (operator only). Runs the same authorization and resolution as a channel button click.',
      args: [
        { name: 'id', type: 'string', description: 'Approval id (from `ncl approvals list`).', required: true },
        {
          name: 'as_user',
          type: 'string',
          description:
            'Approver identity to resolve as — a namespaced user id (e.g. cli:local). Must be an authorized approver of the row.',
          required: true,
        },
      ],
      examples: ['ncl approvals approve --id appr-… --as-user cli:local'],
      handler: (args, ctx) => resolveApprovalFromCli(args, ctx, 'approve'),
      formatHuman: (data) => {
        const r = data as { action: string; approval_id: string };
        return `Approved ${r.action} (${r.approval_id}) and ran its action.`;
      },
    },
    reject: {
      access: 'open',
      description: 'Reject a pending approval (operator only).',
      args: [
        { name: 'id', type: 'string', description: 'Approval id (from `ncl approvals list`).', required: true },
        {
          name: 'as_user',
          type: 'string',
          description: 'Approver identity to resolve as (e.g. cli:local). Must be authorized.',
          required: true,
        },
      ],
      examples: ['ncl approvals reject --id appr-… --as-user cli:local'],
      handler: (args, ctx) => resolveApprovalFromCli(args, ctx, 'reject'),
      formatHuman: (data) => {
        const r = data as { action: string; approval_id: string };
        return `Rejected ${r.action} (${r.approval_id}).`;
      },
    },
    'reject-with-reason': {
      access: 'open',
      description: 'Reject a pending approval and relay a one-line reason to the requesting agent (operator only).',
      args: [
        { name: 'id', type: 'string', description: 'Approval id (from `ncl approvals list`).', required: true },
        {
          name: 'as_user',
          type: 'string',
          description: 'Approver identity to resolve as (e.g. cli:local). Must be authorized.',
          required: true,
        },
        {
          name: 'reason',
          type: 'string',
          description: 'One-line reason relayed to the agent (trimmed to 280 chars).',
          required: true,
        },
      ],
      examples: ['ncl approvals reject-with-reason --id appr-… --as-user cli:local --reason "not this quarter"'],
      handler: (args, ctx) => resolveApprovalFromCli(args, ctx, 'reject-with-reason'),
      formatHuman: (data) => {
        const r = data as { action: string; approval_id: string };
        return `Rejected ${r.action} (${r.approval_id}) with reason.`;
      },
    },
  },
});
