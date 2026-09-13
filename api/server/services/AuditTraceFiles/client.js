/**
 * The thin HTTP client to the BFF's `/console/file-records/*` proxy
 * (`bff/console_file_records_proxy.py` / `bff/app.py::
 * console_file_records_base|console_file_records_proxy` in AuditTrace-AI,
 * consumed here, never modified — mirrors
 * `AuditTraceChatProjects/client.js::callConsoleChatProjectsProxy`'s shape
 * byte-for-byte, per the WU-presets/WU-prompts/WU-chatprojects precedent).
 *
 * **The BFF-facing path is `/console/file-records`, NOT `/console/files`.**
 * The BFF already owns `POST /console/files` for the unrelated, pre-existing
 * M3 Sovereign-Attach WU-2 ephemeral file-ingest route (multipart bytes
 * forwarded to `/memory/upload`) — a completely different concern from this
 * WU's file-METADATA store. `bff/console_file_records_proxy.py` forwards
 * whatever this client sends to the orchestrator's real, spec-literal
 * `/console/files` mount (`src/audittrace/routes/console_files.py`); the
 * renaming is a BFF-side routing concern only, invisible past this module's
 * boundary (see that proxy module's own docstring for the full rationale).
 * Getting this path wrong would silently 404 every request — verified
 * against `bff/app.py`'s route table, not guessed from the domain name.
 *
 * Forwards the CALLER's own access token as-is (`Authorization: Bearer
 * <token>`) — the BFF does the RFC 8693 exchange for the
 * `memory:files:{read-own,write}` scopes server-side; this fork never sees
 * a Keycloak client secret or does any token logic beyond threading it
 * through (explicit, not ambient — see `AuditTraceConversations/index.js`'s
 * module docstring for why the chokepoint this feeds threads a token
 * per-call rather than ambiently).
 *
 * Fail-closed on status code, always: a 401/403/404 the BFF relays is
 * surfaced as the SAME status here, never retried, never reinterpreted,
 * never an excuse to fall back to Mongo (that decision, when it happens at
 * all, is made explicitly by `index.js` on a 404 — see that module's
 * docstring).
 */

const axios = require('axios');
const { logger } = require('@librechat/data-schemas');

const { getConfig } = require('../AuditTraceMemory/config');
const { MissingAccessTokenError, SovereignMemoryError } = require('../AuditTraceMemory/errors');

/**
 * @param {object} params
 * @param {'GET'|'POST'|'DELETE'} params.method
 * @param {string} [params.path] - path suffix after `/console/file-records`,
 *   e.g. `""` (base — list/create), `"<file_id>"`, or `"batch-get"`. An
 *   empty/undefined suffix hits the base path with no trailing slash
 *   (mirrors the BFF's own "path_suffix may be empty" handling).
 * @param {string|null|undefined} params.token - the user's access token.
 * @param {Record<string, string>} [params.query]
 * @param {unknown} [params.body]
 * @returns {Promise<unknown>} the parsed JSON response body (undefined
 *   for a 204 No Content, e.g. a successful delete).
 * @throws {MissingAccessTokenError} if `token` is falsy — the BFF is
 *   never contacted in this case (fail-closed, no network round trip
 *   needed to know "no token" means 401).
 * @throws {SovereignMemoryError} for any non-2xx BFF/orchestrator
 *   response (status mirrors the upstream response byte-for-byte) or a
 *   transport failure (mapped to 502).
 */
async function callConsoleFileRecordsProxy({ method, path, token, query, body }) {
  if (!token) {
    throw new MissingAccessTokenError();
  }

  const { bffBaseUrl, timeoutMs } = getConfig();
  const base = `${bffBaseUrl.replace(/\/+$/, '')}/console/file-records`;
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
    logger.error('[AuditTraceFiles] BFF /console/file-records unreachable', error);
    throw new SovereignMemoryError(
      `sovereign file-records service unreachable: ${error.message}`,
      502,
    );
  }

  if (response.status >= 400) {
    const detail =
      (response.data && (response.data.detail || response.data.error)) || response.statusText;
    throw new SovereignMemoryError(
      `sovereign file-records request failed (${response.status}): ${detail}`,
      response.status,
    );
  }

  // DELETE succeeds at 204 No Content — axios yields `''`/`undefined` for
  // an empty body depending on the response's content-type; normalized to
  // `undefined` here so callers never have to special-case an empty string.
  return response.data || undefined;
}

module.exports = { callConsoleFileRecordsProxy };
