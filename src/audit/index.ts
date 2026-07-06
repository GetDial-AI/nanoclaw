/**
 * Opt-in local audit log (docs/SECURITY.md, "Local Audit Log").
 *
 * Everything composes through the wrappers exported here — business logic
 * contains zero audit calls. emitAuditEvent is deliberately NOT re-exported:
 * only src/audit/ internals may call it.
 */
export * from './types.js';
export { redactDetails } from './redact.js';
export { AUDIT_DIR } from './store.js';
export { initAuditLog, maintainAudit } from './init.js';
export { type AuditHook, registerAuditHook } from './hooks.js';
export { runApprovedHandler, withAudit } from './wrappers.js';
