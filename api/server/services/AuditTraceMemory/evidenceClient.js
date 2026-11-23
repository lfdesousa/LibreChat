/**
 * The thin HTTP client to the BFF's `/console/evidence/*` routes (CONSOLE-AUDIT-EVIDENCE WU-C's
 * contract, consumed here, never modified): two explicit GET routes, one per lookup kind.
 *
 * Mirrors `client.js::callMemoryProxy` deliberately. The CALLER's own access token is forwarded
 * as `Authorization: Bearer <token>` (read by the route off `req.session.openidTokens` and
 * threaded straight through); the BFF does the RFC 8693 exchange for `audittrace:audit`
 * server-side. This module mints nothing and holds no secret.
 *
 * Fail-closed, always:
 *  - no token: the BFF is never contacted (401);
 *  - an id outside the chain's shared predicate: the BFF is never contacted (400), so a crafted id
 *    can never steer the request to another BFF route (path confinement, A1 section 3);
 *  - a 4xx the BFF relays surfaces as the SAME status, never retried, never reinterpreted
 *    (unknown and not-yours are byte-identical 404s upstream; this layer keeps them so).
 * The only header sent is `Authorization`: nothing from the browser request is copied.
 */

const axios = require('axios');
const { logger } = require('@librechat/data-schemas');

const { getConfig } = require('./config');
const { MissingAccessTokenError, SovereignMemoryError } = require('./errors');

/**
 * The shared id predicate of the chain (orchestrator header read, orchestrator path parameter,
 * BFF route, this route): `.` and `..` are refused, no slash, 1 to 255 characters. JS `$` without
 * the `m` flag matches only at the very end of the input, so a trailing line feed fails here as it
 * fails `re.fullmatch` on the Python side.
 */
const MESSAGE_ID_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._:-]{1,255}$/;

/** `interactions.id` is an integer primary key; the BFF route is `{interaction_id:int}`. */
const INTERACTION_ID_PATTERN = /^[0-9]{1,18}$/;

const KINDS = Object.freeze({
  messages: MESSAGE_ID_PATTERN,
  interactions: INTERACTION_ID_PATTERN,
});

class InvalidEvidenceIdError extends SovereignMemoryError {
  constructor(message = 'Invalid evidence id.') {
    super(message, 400);
    this.name = 'InvalidEvidenceIdError';
  }
}

/**
 * @param {object} params
 * @param {'messages'|'interactions'} params.kind
 * @param {unknown} params.id - the LibreChat message id, or the numeric interaction id.
 * @param {string|null|undefined} params.token - the user's access token, read off the session.
 * @returns {Promise<unknown>} the parsed `audittrace.evidence.v1` body, unchanged.
 * @throws {MissingAccessTokenError} no token (401, no network call).
 * @throws {InvalidEvidenceIdError} the id fails the predicate (400, no network call).
 * @throws {SovereignMemoryError} any non-2xx upstream status (relayed) or transport failure (502).
 */
async function callEvidenceProxy({ kind, id, token }) {
  if (!token) {
    throw new MissingAccessTokenError();
  }
  const pattern = Object.hasOwn(KINDS, kind) ? KINDS[kind] : null;
  if (pattern === null || typeof id !== 'string' || !pattern.test(id)) {
    throw new InvalidEvidenceIdError();
  }

  const { bffBaseUrl, timeoutMs } = getConfig();
  const url = `${bffBaseUrl.replace(/\/+$/, '')}/console/evidence/${kind}/${encodeURIComponent(id)}`;

  let response;
  try {
    response = await axios.request({
      method: 'GET',
      url,
      headers: { Authorization: `Bearer ${token}` },
      timeout: timeoutMs,
      validateStatus: () => true,
    });
  } catch (error) {
    logger.error('[AuditTraceMemory] BFF /console/evidence unreachable', error);
    throw new SovereignMemoryError(`evidence service unreachable: ${error.message}`, 502);
  }

  if (response.status >= 400) {
    const detail =
      (response.data && (response.data.detail || response.data.error)) || response.statusText;
    throw new SovereignMemoryError(
      `evidence request failed (${response.status}): ${detail}`,
      response.status,
    );
  }

  return response.data;
}

module.exports = {
  callEvidenceProxy,
  InvalidEvidenceIdError,
  MESSAGE_ID_PATTERN,
  INTERACTION_ID_PATTERN,
};
