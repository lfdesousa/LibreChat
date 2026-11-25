/**
 * Request-scoped access-token propagation (MongoDB-elimination WU-2b —
 * the model-layer-chokepoint pivot, 2026-09-11).
 *
 * `~/models`'s conversation/message method EXPORTS (see `../../../models`'s
 * chokepoint wiring) receive no `req` — they are called from routes,
 * controllers, injected `methods` params (`services/Schedules/index.js`'s
 * `createSchedulesService({ methods, ... })`), and utility modules
 * (`utils/import/fork.js`) alike. A DEDICATED `AsyncLocalStorage` is the
 * enabler that lets the chokepoint read "is there a live user token for
 * THIS call" without threading one more parameter through every caller.
 *
 * **Why a NEW store, not the existing `tenantStorage`
 * (`@librechat/data-schemas`)?** `tenantStorage` already propagates
 * `{tenantId, userId, requestId, ...}` and IS checked first (see the
 * module docstring in `requireJwtAuth.js`) — but `runAsSystem()`
 * (`@librechat/data-schemas`) rebuilds a BRAND NEW context object with
 * only its five known fields whenever cross-tenant system code runs,
 * silently dropping any extra property a caller might have merged in.
 * An access token stashed there would vanish across any `runAsSystem()`
 * boundary without warning. A dedicated, single-purpose store has no such
 * hidden interaction and is easier to reason about: it holds exactly one
 * thing, the request's token SOURCE (plus the token's own subject for
 * observability), for exactly one purpose.
 *
 * **A source, not a string (CONSOLE-LONG-TURN-TOKEN-REFRESH).** The browser's
 * access token lives 300 s and a turn can run for 12+ minutes; a string
 * captured at request start is dead long before the terminal save. The store
 * therefore carries a token SOURCE (`../AuditTraceAuth`'s `TokenSource`) and
 * `getRequestAccessToken()` is AWAITABLE: every call returns a token that is
 * fresh now. A context built with a plain `accessToken` string (a caller with
 * no session, the unit suites) is served as a static source.
 *
 * **Fail-closed by construction:** `getRequestAccessToken()` returns
 * `undefined` for any call outside `runWithRequestAccessToken()` — a
 * background/scheduled job with no live HTTP request never has a store to
 * read, so the chokepoint's "sovereign requires a token" branch simply
 * never fires for it. This IS the disclosed background-writes boundary,
 * not a bug: see `api/models/index.js`'s chokepoint docstring.
 */

const { AsyncLocalStorage } = require('async_hooks');
const { getTokenSource } = require('../AuditTraceAuth/tokenSource');

/**
 * @typedef {{current: () => Promise<string|undefined>}} AccessTokenSource
 * @typedef {{accessToken?: string, source?: AccessTokenSource, sub?: string}} RequestTokenContext
 */

/** @type {AsyncLocalStorage<RequestTokenContext>} */
const requestAccessTokenStorage = new AsyncLocalStorage();

/**
 * Runs `fn` with `{source | accessToken, sub}` available to every synchronous AND
 * asynchronous call `fn` makes (Express middleware chaining, awaited
 * promises, etc. all propagate `AsyncLocalStorage` context correctly;
 * only a raw stream/event-emitter boundary — e.g. multer's multipart
 * parser — can lose it, which is why `routes/convos.js`'s `POST /import`
 * re-establishes it after `handleUpload`, mirroring
 * `restoreTenantContextFromReq`'s own documented reason for existing).
 *
 * @template T
 * @param {RequestTokenContext} context
 * @param {() => T} fn
 * @returns {T}
 */
function runWithRequestAccessToken(context, fn) {
  return requestAccessTokenStorage.run(context, fn);
}

/**
 * @returns {AccessTokenSource|undefined} the current request's token source, or
 *   `undefined` outside `runWithRequestAccessToken` (a background/scheduled job)
 *   or when the request has no token (the user never completed the OIDC console
 *   login). A context built with a plain string is served as a static source.
 */
function getRequestTokenSource() {
  const store = requestAccessTokenStorage.getStore();
  if (store?.source) {
    return store.source;
  }
  if (store?.accessToken) {
    const accessToken = store.accessToken;
    return { current: async () => accessToken };
  }
  return undefined;
}

/**
 * @returns {Promise<string|undefined>} an access token that is fresh now, or
 *   `undefined` when called outside `runWithRequestAccessToken` or when the
 *   request had none. Rejects with a `SovereignSessionError` (`.code`, `.status`)
 *   when the refresh token or the SSO session reached a hard limit.
 */
async function getRequestAccessToken() {
  return getRequestTokenSource()?.current();
}

/** @returns {string|undefined} the current request's subject, best-effort
 *   (observability only — the sovereign API derives identity from the
 *   token itself, never from this). */
function getRequestSub() {
  return requestAccessTokenStorage.getStore()?.sub;
}

/**
 * Express middleware: re-establishes the CURRENT request's token context. For
 * use ONLY after middleware that may cross an async stream/event-emitter
 * boundary that can drop `AsyncLocalStorage` propagation (multer's multipart
 * parser, specifically) — mirroring `restoreTenantContextFromReq`'s own
 * documented reason for existing at the exact same call site
 * (`routes/convos.js`'s `POST /import`, after `handleUpload`). Builds the SAME
 * source `requireJwtAuth.js` originally populated the context with (one source
 * per request) — a re-entry, not new business logic.
 *
 * @param {object} req
 * @param {object} _res
 * @param {Function} next
 */
function restoreRequestAccessTokenContext(req, _res, next) {
  runWithRequestAccessToken({ source: getTokenSource(req), sub: req.user?.id }, next);
}

module.exports = {
  runWithRequestAccessToken,
  getRequestAccessToken,
  getRequestTokenSource,
  getRequestSub,
  restoreRequestAccessTokenContext,
  // Exported for direct unit testing only.
  _requestAccessTokenStorage: requestAccessTokenStorage,
};
