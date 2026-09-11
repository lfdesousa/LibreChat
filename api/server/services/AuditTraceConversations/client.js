/**
 * The thin HTTP client to the BFF's `/console/conversations/*` proxy
 * (WU-1's contract — `bff/console_conversations_proxy.py` /
 * `bff/app.py::console_conversations_base|console_conversations_proxy` in
 * AuditTrace-AI, consumed here, never modified).
 *
 * Deliberately mirrors `AuditTraceMemory/client.js::callMemoryProxy`'s
 * discipline byte-for-byte (same fail-closed contract, same
 * `MissingAccessTokenError`/`SovereignMemoryError` split), reusing that
 * module's `getConfig`/error types rather than duplicating them — the BFF
 * base URL and timeout are the SAME toggle (`AUDITTRACE_BFF_BASE_URL`,
 * `AUDITTRACE_BFF_TIMEOUT_MS`) whether the request lands under `/memory/*`
 * or `/console/conversations/*`; only the path prefix differs (WU-1's own
 * `bff/config.py::orchestrator_console_conversations_path_prefix` is a
 * SEPARATE setting from the memory-proxy prefix on the AuditTrace-AI side,
 * but on THIS side both proxies share one BFF host + one client
 * discipline, so re-deriving a second config module here would only
 * invite the two toggles to drift).
 *
 * Forwards the CALLER's own access token as-is (`Authorization: Bearer
 * <token>`) — the BFF does the RFC 8693 exchange for the
 * `memory:conversations:{read-own,write}` scopes server-side; this fork
 * never sees a Keycloak client secret or does any token logic beyond
 * threading it through (explicit, not ambient — see `index.js`'s module
 * docstring).
 *
 * Fail-closed on status code, always: a 401/403/404 the BFF relays is
 * surfaced as the SAME status here, never retried, never reinterpreted,
 * never an excuse to fall back to Mongo.
 */

const axios = require('axios');
const { logger } = require('@librechat/data-schemas');

const { getConfig } = require('../AuditTraceMemory/config');
const { MissingAccessTokenError, SovereignMemoryError } = require('../AuditTraceMemory/errors');

/**
 * @param {object} params
 * @param {'GET'|'POST'|'PATCH'|'DELETE'} params.method
 * @param {string} [params.path] - path suffix after `/console/conversations`,
 *   e.g. `""` (base — list/create), `"<conversationId>"`, or
 *   `"<conversationId>/messages"`. An empty/undefined suffix hits the base
 *   path with no trailing slash (mirrors the BFF's own "path_suffix may be
 *   empty" handling).
 * @param {string|null|undefined} params.token - the user's access token.
 * @param {Record<string, string>} [params.query]
 * @param {unknown} [params.body]
 * @returns {Promise<unknown>} the parsed JSON response body.
 * @throws {MissingAccessTokenError} if `token` is falsy — the BFF is
 *   never contacted in this case (fail-closed, no network round trip
 *   needed to know "no token" means 401).
 * @throws {SovereignMemoryError} for any non-2xx BFF/orchestrator
 *   response (status mirrors the upstream response byte-for-byte) or a
 *   transport failure (mapped to 502).
 */
async function callConsoleConversationsProxy({ method, path, token, query, body }) {
  if (!token) {
    throw new MissingAccessTokenError();
  }

  const { bffBaseUrl, timeoutMs } = getConfig();
  const base = `${bffBaseUrl.replace(/\/+$/, '')}/console/conversations`;
  const suffix = String(path || '').replace(/^\/+/, '');
  const url = suffix ? `${base}/${suffix}` : base;

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
    logger.error('[AuditTraceConversations] BFF /console/conversations unreachable', error);
    throw new SovereignMemoryError(
      `sovereign conversations service unreachable: ${error.message}`,
      502,
    );
  }

  if (response.status >= 400) {
    const detail =
      (response.data && (response.data.detail || response.data.error)) || response.statusText;
    throw new SovereignMemoryError(
      `sovereign conversations request failed (${response.status}): ${detail}`,
      response.status,
    );
  }

  return response.data;
}

module.exports = { callConsoleConversationsProxy };
