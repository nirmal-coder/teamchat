'use strict';
/**
 * Shared error type + guard helpers. Used by every feature module so error
 * codes and the throw pattern are defined once. CUT-COPY-PASTE SAFE: import
 * { EngineError, ensure } and reuse — never redefine these per feature.
 */
const F = require('./frames');

class EngineError extends Error {
  constructor(code, detail) { super(detail); this.name = 'EngineError'; this.code = code; }
}

/** Throw EngineError(code, msg) unless cond is truthy. Replaces 34 inline throws. */
function ensure(cond, code, msg) {
  if (!cond) throw new EngineError(code, msg);
}

/** Membership guard — reused by ingest, react, pin, poll, vote, viewOnce, timer. */
async function requireMember(storage, convId, userId) {
  ensure(await storage.isMember(convId, userId), F.E.NOT_MEMBER, 'not a member of conversation');
}

/** Admin guard — reused by subject, group promote/demote/add/remove. */
async function requireAdmin(storage, convId, userId) {
  ensure(await storage.isAdmin(convId, userId), F.E.NOT_ADMIN, 'admin privilege required');
}

/**
 * Fetch + validate a target message exists in this conversation and is live.
 * Reused by edit, delete, react, pin, viewOnce. Returns the doc.
 */
async function requireTarget(storage, convId, targetUlid, { allowDeleted = false } = {}) {
  const target = await storage.getByUlid(targetUlid);
  ensure(target && target.convId === convId, F.E.NOT_FOUND, 'message not found');
  if (!allowDeleted) ensure(!target.deleted, F.E.NOT_FOUND, 'message deleted');
  return target;
}

module.exports = { EngineError, ensure, requireMember, requireAdmin, requireTarget };
