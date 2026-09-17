/**
 * The thin HTTP client to the BFF's `/console/conversation-tags/*` proxy
 * (`bff/console_conversation_tags_proxy.py` / `bff/app.py::
 * console_conversation_tags_base|console_conversation_tags_proxy` in
 * AuditTrace-AI, consumed here, never modified — mirrors
 * `AuditTraceFiles/client.js::callConsoleFileRecordsProxy`'s shape
 * byte-for-byte, per the WU-presets/WU-prompts/WU-chatprojects/WU-files
 * precedent).
 *
 * **The one thing this client owns that its siblings don't: path-segment
 * encoding.** Every prior domain's id (`presetId`/`groupId`/
 * `chatProjectId`/`file_id`) is a UUID/hex string with no characters that
 * need escaping in a URL path segment. A conversation-tag's identity IS
 * its `tag` — a free-form, user-typed string (`routes/tags.js` even
 * `decodeURIComponent`s it before calling the model layer) that can
 * itself contain a literal `/` (the orchestrator route is declared
 * `{tag:path}` for exactly this reason — see
 * `src/audittrace/routes/console_conversation_tags.py`'s docstring).
 * `encodeTagPath` therefore encodes EACH `/`-delimited segment with
 * `encodeURIComponent` and rejoins with literal `/`: a tag containing no
 * slash round-trips as one safely-escaped segment; a tag containing a
 * slash round-trips as multiple segments, which is exactly what the
 * orchestrator's `:path` param is built to accept. Never applied to the
 * base list/create path (`""`), which carries no tag in the URL.
 *
 * Forwards the CALLER's own access token as-is (`Authorization: Bearer
 * <token>`) — the BFF does the RFC 8693 exchange for the
 * `memory:conversation_tags:{read-own,write}` scopes server-side; this
 * fork never sees a Keycloak client secret or does any token logic
 * beyond threading it through (explicit, not ambient — see
 * `AuditTraceConversations/index.js`'s module docstring for why the
 * chokepoint this feeds threads a token per-call rather than ambiently).
 *
 * Fail-closed on status code, always: a 401/403/404 the BFF relays is
 * surfaced as the SAME status here, never retried, never reinterpreted,
 * never an excuse to fall back to Mongo (that decision, when it happens
 * at all, is made explicitly by the domain adapter on a 404 — see
 * `../AuditTraceSovereignAdapter`'s docstring).
 */

const axios = require('axios');
const { logger } = require('@librechat/data-schemas');

const { getConfig } = require('../AuditTraceMemory/config');
const { MissingAccessTokenError, SovereignMemoryError } = require('../AuditTraceMemory/errors');

/**
 * Percent-encodes each `/`-delimited segment of a tag so it survives as
 * a URL path suffix while preserving the orchestrator's `{tag:path}`
 * multi-segment shape for a tag that itself contains a literal `/`. The
 * empty string maps to itself (the base list/create path never calls
 * this).
 *
 * @param {string} tag
 * @returns {string}
 */
function encodeTagPath(tag) {
  return tag.split('/').map(encodeURIComponent).join('/');
}

/**
 * @param {object} params
 * @param {'GET'|'POST'|'DELETE'} params.method
 * @param {string} [params.path] - path suffix after
 *   `/console/conversation-tags`, e.g. `""` (base — list/create) or a
 *   `tag` (percent-encoded per segment via `encodeTagPath`). An empty/
 *   undefined suffix hits the base path with no trailing slash (mirrors
 *   the BFF's own "path_suffix may be empty" handling).
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
async function callConsoleConversationTagsProxy({ method, path, token, query, body }) {
  if (!token) {
    throw new MissingAccessTokenError();
  }

  const { bffBaseUrl, timeoutMs } = getConfig();
  const base = `${bffBaseUrl.replace(/\/+$/, '')}/console/conversation-tags`;
  const rawSuffix = String(path || '').replace(/^\/+/, '');
  const suffix = rawSuffix ? encodeTagPath(rawSuffix) : '';
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
    logger.error('[AuditTraceConversationTags] BFF /console/conversation-tags unreachable', error);
    throw new SovereignMemoryError(
      `sovereign conversation-tags service unreachable: ${error.message}`,
      502,
    );
  }

  if (response.status >= 400) {
    const detail =
      (response.data && (response.data.detail || response.data.error)) || response.statusText;
    throw new SovereignMemoryError(
      `sovereign conversation-tags request failed (${response.status}): ${detail}`,
      response.status,
    );
  }

  // DELETE succeeds at 204 No Content — axios yields `''`/`undefined` for
  // an empty body depending on the response's content-type; normalized to
  // `undefined` here so callers never have to special-case an empty string.
  return response.data || undefined;
}

module.exports = { callConsoleConversationTagsProxy, encodeTagPath };
