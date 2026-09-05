/**
 * The console's narrow ephemeral file-ingest arm of the sovereign memory
 * adapter (M3 Sovereign-Attach WU-3) — POSTs a byte-faithful multipart
 * upload to the BFF's `POST /console/files` (WU-2's forced-layer,
 * narrow-scope seam; consumed here, never modified).
 *
 * This is a DIFFERENT endpoint from the one `client.js::callMemoryProxy`
 * wraps: `/console/files` sits at the BFF root, not under `/memory/*`, so
 * it gets its own thin HTTP client rather than being shoehorned through
 * `callMemoryProxy`'s `/memory/<path>` URL construction. Everything else
 * mirrors `callMemoryProxy` deliberately: the CALLER's own access token is
 * forwarded as-is (`Authorization: Bearer <token>`, read by the caller off
 * `req.session.openidTokens.accessToken` and threaded straight through —
 * explicit, not ambient); the BFF does the RFC 8693 exchange for
 * `memory:session:write` server-side; this module performs NO token logic
 * of its own — no minting, no Keycloak secret, no exchange.
 *
 * Fail-closed on status code, always: a 4xx/5xx the BFF relays (400 PDF→
 * session refusal, 403 durable-layer, 413 too-large, ...) is surfaced as
 * the SAME status here, never retried, never reinterpreted, never an
 * excuse to fall back to Mongo.
 */

const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const { logger } = require('@librechat/data-schemas');

const { getConfig } = require('./config');
const { MissingAccessTokenError, SovereignMemoryError } = require('./errors');

/**
 * @param {object} params
 * @param {string|null|undefined} params.token - the user's Keycloak OIDC
 *   access token. NEVER minted here — the caller reads it off
 *   `req.session.openidTokens.accessToken` and threads it through.
 * @param {string} params.filePath - path to the file already saved to
 *   local disk (the same `file.path` the legacy `${RAG_API_URL}/embed`
 *   call reads).
 * @param {string} params.filename - the original filename to present in
 *   the multipart part, so the orchestrator's `/memory/upload` sees the
 *   real name rather than a temp-path basename.
 * @param {string} [params.contentType] - the file's MIME type, if known.
 * @returns {Promise<Record<string, unknown>>} the BFF response body,
 *   UNCHANGED (the session-memory key/id WU-5 recall will reference).
 * @throws {MissingAccessTokenError} if `token` is falsy — the BFF is
 *   NEVER contacted in this case (fail-closed, no network round trip
 *   needed to know "no token" means 401).
 * @throws {SovereignMemoryError} for any non-2xx BFF/orchestrator
 *   response (status mirrors the upstream response byte-for-byte) or a
 *   transport failure (mapped to 502).
 */
async function callConsoleFilesProxy({ token, filePath, filename, contentType }) {
  if (!token) {
    throw new MissingAccessTokenError();
  }

  const { bffBaseUrl, timeoutMs } = getConfig();
  const url = `${bffBaseUrl.replace(/\/+$/, '')}/console/files`;

  const formData = new FormData();
  formData.append('file', fs.createReadStream(filePath), {
    filename,
    contentType,
  });

  let response;
  try {
    response = await axios.post(url, formData, {
      headers: {
        Authorization: `Bearer ${token}`,
        ...formData.getHeaders(),
      },
      timeout: timeoutMs,
      // Status is inspected explicitly below (fail-closed relay) rather
      // than letting axios throw and lose the distinction between "the
      // BFF answered 4xx" and "the BFF was unreachable".
      validateStatus: () => true,
    });
  } catch (error) {
    logger.error('[AuditTraceMemory] BFF /console/files unreachable', error);
    throw new SovereignMemoryError(
      `sovereign console-files service unreachable: ${error.message}`,
      502,
    );
  }

  if (response.status >= 400) {
    const detail =
      (response.data && (response.data.detail || response.data.error)) || response.statusText;
    throw new SovereignMemoryError(
      `sovereign console-files upload failed (${response.status}): ${detail}`,
      response.status,
    );
  }

  return response.data;
}

module.exports = { callConsoleFilesProxy };
