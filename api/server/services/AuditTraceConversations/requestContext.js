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
 * thing, an access token (plus the token's own subject for
 * observability), for exactly one purpose.
 *
 * **Fail-closed by construction:** `getRequestAccessToken()` returns
 * `undefined` for any call outside `runWithRequestAccessToken()` — a
 * background/scheduled job with no live HTTP request never has a store to
 * read, so the chokepoint's "sovereign requires a token" branch simply
 * never fires for it. This IS the disclosed background-writes boundary,
 * not a bug: see `api/models/index.js`'s chokepoint docstring.
 */

const { AsyncLocalStorage } = require('async_hooks');

/** @type {AsyncLocalStorage<{accessToken?: string, sub?: string}>} */
const requestAccessTokenStorage = new AsyncLocalStorage();

/**
 * Runs `fn` with `{accessToken, sub}` available to every synchronous AND
 * asynchronous call `fn` makes (Express middleware chaining, awaited
 * promises, etc. all propagate `AsyncLocalStorage` context correctly;
 * only a raw stream/event-emitter boundary — e.g. multer's multipart
 * parser — can lose it, which is why `routes/convos.js`'s `POST /import`
 * re-establishes it after `handleUpload`, mirroring
 * `restoreTenantContextFromReq`'s own documented reason for existing).
 *
 * @template T
 * @param {{accessToken?: string, sub?: string}} context
 * @param {() => T} fn
 * @returns {T}
 */
function runWithRequestAccessToken(context, fn) {
  return requestAccessTokenStorage.run(context, fn);
}

/**
 * @returns {string|undefined} the current request's access token, or
 *   `undefined` when called outside `runWithRequestAccessToken` (no live
 *   HTTP request — a background/scheduled job) or when the request had
 *   none (e.g. the user never completed the OIDC console login).
 */
function getRequestAccessToken() {
  return requestAccessTokenStorage.getStore()?.accessToken;
}

/** @returns {string|undefined} the current request's subject, best-effort
 *   (observability only — the sovereign API derives identity from the
 *   token itself, never from this). */
function getRequestSub() {
  return requestAccessTokenStorage.getStore()?.sub;
}

/**
 * Express middleware: re-establishes the CURRENT request's access-token
 * context. For use ONLY after middleware that may cross an async
 * stream/event-emitter boundary that can drop `AsyncLocalStorage`
 * propagation (multer's multipart parser, specifically) — mirroring
 * `restoreTenantContextFromReq`'s own documented reason for existing at
 * the exact same call site (`routes/convos.js`'s `POST /import`, after
 * `handleUpload`). Reads the SAME `req.session.openidTokens.accessToken`/
 * `req.user.id` `requireJwtAuth.js` originally populated the context
 * from — this is a re-entry, not new business logic, and is NOT
 * per-route sovereign-routing wiring (the chokepoint itself lives
 * entirely in `api/models/index.js`; this only keeps the ONE ambient
 * signal it reads alive across a stream boundary already known to drop
 * ambient context for the pre-existing tenant store).
 *
 * @param {object} req
 * @param {object} _res
 * @param {Function} next
 */
function restoreRequestAccessTokenContext(req, _res, next) {
  runWithRequestAccessToken(
    { accessToken: req.session?.openidTokens?.accessToken, sub: req.user?.id },
    next,
  );
}

module.exports = {
  runWithRequestAccessToken,
  getRequestAccessToken,
  getRequestSub,
  restoreRequestAccessTokenContext,
  // Exported for direct unit testing only.
  _requestAccessTokenStorage: requestAccessTokenStorage,
};
