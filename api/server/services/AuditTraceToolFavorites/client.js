/**
 * The thin HTTP client to the BFF's `/console/tool-favorites/*` proxy
 * (`bff/console_tool_favorites_proxy.py` / `bff/app.py::
 * console_tool_favorites_base|console_tool_favorites_proxy` in
 * AuditTrace-AI, consumed here, never modified — mirrors
 * `AuditTraceConversationTags/client.js::callConsoleConversationTagsProxy`'s
 * shape byte-for-byte).
 *
 * **This domain's identity is a PAIR, not a scalar.** A tool-favorite's
 * uniqueness is `(user, item_type, item_id)` — there is no single `id`
 * field. The orchestrator's own REST surface reflects this: the delete
 * route is `DELETE /console/tool-favorites/{item_type}/{item_id:path}`,
 * two path segments, not one
 * (`src/audittrace/routes/console_tool_favorites.py`). `item_id` is a
 * CLIENT-SUPPLIED free-form string (e.g. an MCP-qualified tool name) and
 * may itself contain a `/` — the route's own docstring says so explicitly
 * ("may itself contain a `/`, so the route param must accept path
 * segments, not just a single path component") — so this client's path
 * builder percent-encodes each `/`-delimited segment and refuses a `.`/
 * `..` segment exactly as `AuditTraceConversationTags/client.js::
 * encodeTagPath` does, for the SAME reason: `encodeURIComponent` does not
 * escape `.` (RFC 3986 unreserved), so an unescaped `..` segment survives
 * into the URL and is collapsed by the WHATWG "remove dot segments" step
 * against whatever precedes it — including this client's own
 * `/console/tool-favorites` prefix — before the request ever leaves the
 * process. See `encodeTagPath`'s docstring (identical reasoning, not
 * repeated here) for why refusal, not an alternate escape, is the only
 * correct move.
 *
 * **No standalone get-by-key route exists for this domain** (deliberate,
 * per `2026-09-13-SPEC-mongo-repl-wu-tool-favorites-store.md`: "no
 * standalone get-by-key route (the fork's own `methods/favorite.ts` never
 * exposes one either)"). Confirmed empirically — a `GET` to the
 * `{item_type}/{item_id}` shape resolves to the DELETE-only route's PATH
 * pattern and Starlette answers **405 Method Not Allowed**, not 404 (see
 * `../AuditTraceToolFavorites/index.js`'s module docstring for the
 * committed FastAPI `TestClient` reproduction and the consequence this
 * has for which base primitives this domain can compose). This client
 * therefore never issues a GET to a `{item_type}/{item_id}` path; only
 * `''` (list/add) and a DELETE by path are ever built here.
 *
 * Forwards the CALLER's own access token as-is (`Authorization: Bearer
 * <token>`) — the BFF does the RFC 8693 exchange for the
 * `memory:tool_favorites:{read-own,write}` scopes server-side; this fork
 * never sees a Keycloak client secret.
 *
 * Fail-closed on status code, always: a 401/403/404/405/409 the BFF
 * relays is surfaced as the SAME status here, never retried, never
 * reinterpreted, never an excuse to fall back to Mongo (that decision is
 * made explicitly by the domain adapter — see `./index.js`).
 */

const axios = require('axios');
const { logger } = require('@librechat/data-schemas');

const { getConfig } = require('../AuditTraceMemory/config');
const { MissingAccessTokenError, SovereignMemoryError } = require('../AuditTraceMemory/errors');

/**
 * A `/`-delimited segment that WHATWG URL parsing treats as a relative
 * navigation segment when it appears in a path — `.` or `..`. Checked
 * case-insensitively against the RAW (pre-`encodeURIComponent`) segment
 * text. Identical to `AuditTraceConversationTags/client.js::isDotSegment`.
 *
 * @param {string} segment
 * @returns {boolean}
 */
function isDotSegment(segment) {
  const lowered = segment.toLowerCase();
  return lowered === '.' || lowered === '..';
}

/**
 * Percent-encodes each `/`-delimited segment of a tool-favorites path
 * suffix (an `item_id`, possibly itself containing `/`) so it survives as
 * a URL path suffix while refusing a `.`/`..` segment BEFORE any network
 * hop (fail-closed) — see the module docstring for why. The empty string
 * maps to itself (the base list/add path never calls this).
 *
 * @param {string} suffix
 * @returns {string}
 * @throws {SovereignMemoryError} (400) if any `/`-delimited segment is
 *   exactly `.` or `..`.
 */
function encodeFavoritePath(suffix) {
  return suffix
    .split('/')
    .map((segment) => {
      if (isDotSegment(segment)) {
        throw new SovereignMemoryError(
          '[AuditTraceToolFavorites] a path segment of "." or ".." would escape the ' +
            'tool-favorites path when the request URL is resolved — refused (fail-closed)',
          400,
        );
      }
      return encodeURIComponent(segment);
    })
    .join('/');
}

/**
 * @param {object} params
 * @param {'GET'|'POST'|'DELETE'} params.method
 * @param {string} [params.path] - path suffix after
 *   `/console/tool-favorites`, e.g. `""` (base — list/add) or
 *   `"<item_type>/<item_id>"` (percent-encoded per segment via
 *   `encodeFavoritePath`, delete only — see the module docstring for why
 *   this client never issues a GET to this shape).
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
async function callConsoleToolFavoritesProxy({ method, path, token, query, body }) {
  if (!token) {
    throw new MissingAccessTokenError();
  }

  const { bffBaseUrl, timeoutMs } = getConfig();
  const base = `${bffBaseUrl.replace(/\/+$/, '')}/console/tool-favorites`;
  const rawSuffix = String(path || '').replace(/^\/+/, '');
  const suffix = rawSuffix ? encodeFavoritePath(rawSuffix) : '';
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
    logger.error('[AuditTraceToolFavorites] BFF /console/tool-favorites unreachable', error);
    throw new SovereignMemoryError(
      `sovereign tool-favorites service unreachable: ${error.message}`,
      502,
    );
  }

  if (response.status >= 400) {
    const detail =
      (response.data && (response.data.detail || response.data.error)) || response.statusText;
    throw new SovereignMemoryError(
      `sovereign tool-favorites request failed (${response.status}): ${detail}`,
      response.status,
    );
  }

  // DELETE succeeds at 204 No Content — axios yields `''`/`undefined` for
  // an empty body depending on the response's content-type; normalized to
  // `undefined` here so callers never have to special-case an empty string.
  return response.data || undefined;
}

module.exports = { callConsoleToolFavoritesProxy, encodeFavoritePath };
