/**
 * The thin HTTP client to the BFF's `/console/prompts/*` proxy
 * (`bff/console_prompts_proxy.py` / `bff/app.py::console_prompts_base|
 * console_prompts_proxy` in AuditTrace-AI, consumed here, never modified —
 * mirrors `bff/console_presets_proxy.py`'s shape byte-for-byte, per the
 * WU-presets precedent, which itself mirrored
 * `bff/console_conversations_proxy.py`).
 *
 * Deliberately mirrors `AuditTracePresets/client.js::
 * callConsolePresetsProxy`'s discipline byte-for-byte (same fail-closed
 * contract, same `MissingAccessTokenError`/`SovereignMemoryError` split),
 * reusing that module's `getConfig`/error types rather than duplicating
 * them — the BFF base URL and timeout are the SAME toggle
 * (`AUDITTRACE_BFF_BASE_URL`, `AUDITTRACE_BFF_TIMEOUT_MS`) whether the
 * request lands under `/console/conversations/*`, `/console/presets/*`,
 * or `/console/prompts/*`; only the path prefix differs.
 *
 * Forwards the CALLER's own access token as-is (`Authorization: Bearer
 * <token>`) — the BFF does the RFC 8693 exchange for the
 * `memory:prompts:{read-own,write}` scopes server-side; this fork never
 * sees a Keycloak client secret or does any token logic beyond threading
 * it through (explicit, not ambient — see
 * `AuditTraceConversations/index.js`'s module docstring for why the
 * chokepoint this feeds threads a token per-call rather than ambiently).
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
 * @param {string} [params.path] - path suffix after `/console/prompts`,
 *   e.g. `""` (base — list/create), `"<groupId>"`,
 *   `"<groupId>/versions"`, or `"<groupId>/production"`. An empty/
 *   undefined suffix hits the base path with no trailing slash (mirrors
 *   the BFF's own "path_suffix may be empty" handling).
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
async function callConsolePromptsProxy({ method, path, token, query, body }) {
  if (!token) {
    throw new MissingAccessTokenError();
  }

  const { bffBaseUrl, timeoutMs } = getConfig();
  const base = `${bffBaseUrl.replace(/\/+$/, '')}/console/prompts`;
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
    logger.error('[AuditTracePrompts] BFF /console/prompts unreachable', error);
    throw new SovereignMemoryError(`sovereign prompts service unreachable: ${error.message}`, 502);
  }

  if (response.status >= 400) {
    const detail =
      (response.data && (response.data.detail || response.data.error)) || response.statusText;
    throw new SovereignMemoryError(
      `sovereign prompts request failed (${response.status}): ${detail}`,
      response.status,
    );
  }

  return response.data;
}

module.exports = { callConsolePromptsProxy };
