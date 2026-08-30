/**
 * The thin HTTP client to the BFF's `/memory/*` proxy (M3-WU-D2-1's
 * contract — `bff/memory_proxy.py` / `bff/app.py::memory_proxy` in
 * AuditTrace-AI, consumed here, never modified).
 *
 * Forwards the CALLER's own access token as-is (`Authorization: Bearer
 * <token>`) — the BFF does the RFC 8693 exchange for the memory scope
 * set server-side; this fork never sees a Keycloak client secret or does
 * any token logic beyond reading it off the session
 * (`req.session.openidTokens.accessToken`) and passing it through
 * (explicit threading, not AsyncLocalStorage — see the module docstring
 * on `AuditTraceMemory/index.js`).
 *
 * Fail-closed on status code, always: a 401/403/404 the BFF relays is
 * surfaced as the SAME status here, never retried, never reinterpreted,
 * never a excuse to fall back to Mongo.
 */

const axios = require('axios');
const { logger } = require('@librechat/data-schemas');

const { getConfig } = require('./config');
const { MissingAccessTokenError, SovereignMemoryError } = require('./errors');

/**
 * @param {object} params
 * @param {'GET'|'POST'|'PUT'|'DELETE'} params.method
 * @param {string} params.path - path suffix after `/memory/`, e.g.
 *   `"episodic"` or `"semantic/librechat_personalization/timezone"`.
 * @param {string|null|undefined} params.token - the user's access token.
 * @param {Record<string, string>} [params.query]
 * @param {unknown} [params.body]
 * @returns {Promise<unknown>} the parsed JSON response body.
 * @throws {MissingAccessTokenError} if `token` is falsy — the BFF is
 *   never contacted in this case (fail-closed, no network round trip
 *   needed to know "no token" means 401).
 * @throws {SovereignMemoryError} for any non-2xx BFF/orchestrator
 *   response (status mirrors the upstream response byte-for-byte) or a
 *   transport failure (mapped to 502, matching
 *   `bff.memory_proxy.MemoryProxyError`'s own discipline).
 */
async function callMemoryProxy({ method, path, token, query, body }) {
  if (!token) {
    throw new MissingAccessTokenError();
  }

  const { bffBaseUrl, timeoutMs } = getConfig();
  const url = `${bffBaseUrl.replace(/\/+$/, '')}/memory/${path.replace(/^\/+/, '')}`;

  let response;
  try {
    response = await axios.request({
      method,
      url,
      params: query,
      data: body,
      headers: { Authorization: `Bearer ${token}` },
      timeout: timeoutMs,
      // Status is inspected explicitly below (fail-closed relay) rather
      // than letting axios throw and lose the distinction between "the
      // BFF answered 404" and "the BFF was unreachable".
      validateStatus: () => true,
    });
  } catch (error) {
    logger.error('[AuditTraceMemory] BFF /memory unreachable', error);
    throw new SovereignMemoryError(`sovereign memory service unreachable: ${error.message}`, 502);
  }

  if (response.status >= 400) {
    const detail =
      (response.data && (response.data.detail || response.data.error)) || response.statusText;
    throw new SovereignMemoryError(
      `sovereign memory request failed (${response.status}): ${detail}`,
      response.status,
    );
  }

  return response.data;
}

module.exports = { callMemoryProxy };
