const {
  GenerationJobManager,
  createMessageRequestMiddleware,
  isPendingActionStale,
} = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { getConvoOwnership } = require('~/models');
const { resolveConversationMethods } = require('~/server/services/AuditTraceConversations');

/**
 * MongoDB-elimination WU-2 remediation (2026-09-11 exhaustive-audit pass).
 *
 * `createMessageRequestMiddleware`'s `getConvo` dependency was bound ONCE,
 * here, at module load — before any request (and therefore any
 * `AUDITTRACE_MEMORY_BACKEND`/token) exists. Every route this validation
 * gates (`routes/messages.js`'s `GET/PUT/DELETE /:conversationId/:messageId`,
 * `GET /:conversationId`) had already been wired to read/write the
 * sovereign store for its OWN persistence, but this shared ownership CHECK
 * still ran against Mongo only — so a sovereign-only conversation 404'd
 * here, before the wired handler's own sovereign read/write ever ran. A
 * real, severe gap the exhaustive audit caught (not disclosed — fixed):
 * every "wired" single-message route was silently dead for a
 * sovereign-only conversation.
 *
 * Fix: build a FRESH `createMessageRequestMiddleware(...)` per request,
 * with `getConvo` resolved via `resolveConversationMethods({req,
 * mongoMethods: {getConvo: getConvoOwnership}})` — the SAME per-request
 * resolver seam every other wired call site in this fork uses. This is
 * cheap (closures only, no I/O) and introduces no ambient state (no
 * AsyncLocalStorage, no module-level "current user" — the house rule
 * `AuditTraceMemory/index.js`'s module docstring establishes).
 *
 * `canReadActiveJobConversation`/`sendValidationResponse` have no
 * `getConvo` dependency (only `getJob`/`isPendingActionStale`, or pure
 * response formatting) and stay module-load-bound, unaffected.
 */
const staticMiddleware = createMessageRequestMiddleware({
  getConvo: getConvoOwnership,
  getJob: (conversationId) => GenerationJobManager.getJob(conversationId),
  isPendingActionStale,
  logger,
});

/**
 * Builds the `getConvo` dependency for THIS request: the sovereign-bound
 * adapter function under `AUDITTRACE_MEMORY_BACKEND=sovereign`, or the raw
 * `getConvoOwnership` unchanged otherwise (byte-identical default path).
 *
 * @param {object} req
 * @returns {(userId: string, conversationId?: string) => Promise<unknown>}
 */
function resolveGetConvoForRequest(req) {
  return resolveConversationMethods({
    req,
    mongoMethods: { getConvo: getConvoOwnership },
  }).getConvo;
}

/** @type {import('@librechat/api').MessageRequestMiddleware['prepareMessageRequestValidation']} */
function prepareMessageRequestValidation(req, res, next) {
  return createMessageRequestMiddleware({
    getConvo: resolveGetConvoForRequest(req),
    getJob: (conversationId) => GenerationJobManager.getJob(conversationId),
    isPendingActionStale,
    logger,
  }).prepareMessageRequestValidation(req, res, next);
}

/** @type {import('@librechat/api').MessageRequestMiddleware['validateMessageReq']} */
function validateMessageReq(req, res, next) {
  return createMessageRequestMiddleware({
    getConvo: resolveGetConvoForRequest(req),
    getJob: (conversationId) => GenerationJobManager.getJob(conversationId),
    isPendingActionStale,
    logger,
  }).validateMessageReq(req, res, next);
}

module.exports = {
  canReadActiveJobConversation: staticMiddleware.canReadActiveJobConversation,
  prepareMessageRequestValidation,
  sendValidationResponse: staticMiddleware.sendValidationResponse,
  validateMessageReq,
};
