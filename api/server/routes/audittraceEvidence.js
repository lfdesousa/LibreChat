const express = require('express');
const { logger } = require('@librechat/data-schemas');

const { requireJwtAuth } = require('~/server/middleware');
const { getFreshAccessToken } = require('~/server/services/AuditTraceAuth');
const { callEvidenceProxy } = require('~/server/services/AuditTraceMemory/evidenceClient');
const { SovereignMemoryError } = require('~/server/services/AuditTraceMemory/errors');

/**
 * CONSOLE-AUDIT-EVIDENCE WU-D — the fork's evidence route.
 *
 * Renders, never stores: no Mongo read or write, no cache. The user's own access token is read
 * server-side from the session LibreChat's OpenID login already populates (the `memories.js`
 * pattern); the fork gains no Keycloak client and no token logic. Two explicit GET routes, one
 * per lookup kind; the data path is the BFF `/console/evidence/*` routes and nothing else.
 */
const router = express.Router();

router.use(requireJwtAuth);

/** A token that is fresh now; `null` (never `undefined`) when absent, so every call below fails closed the same way. */
const getAccessToken = async (req) => (await getFreshAccessToken(req)) || null;

const respondError = (res, error) => {
  if (error instanceof SovereignMemoryError) {
    return res.status(error.status).json({ error: error.message });
  }
  logger.error('[audittraceEvidence] unexpected error', error);
  return res.status(500).json({ error: 'Failed to process evidence request.' });
};

const evidenceHandler = (kind, param) => async (req, res) => {
  try {
    const body = await callEvidenceProxy({
      kind,
      id: req.params[param],
      token: await getAccessToken(req),
    });
    return res.status(200).json(body);
  } catch (error) {
    return respondError(res, error);
  }
};

/** GET /api/audittrace/evidence/messages/:messageId — the assistant message's evidence. */
router.get('/messages/:messageId', evidenceHandler('messages', 'messageId'));

/** GET /api/audittrace/evidence/interactions/:interactionId — by audit-row id. */
router.get('/interactions/:interactionId', evidenceHandler('interactions', 'interactionId'));

module.exports = router;
