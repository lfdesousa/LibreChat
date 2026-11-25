/**
 * AuditTraceAuth — the request token source and its failure vocabulary.
 *
 * The console's browser token is the IdP access token (`OPENID_REUSE_TOKENS`) and lives 300 s;
 * a turn can outlive it many times. This package keeps the token fresh for as long as the
 * request runs and names the four ways it can hit a hard limit. It is the ONLY non-test
 * place (with `AuthService`, `AuthController`, the strategy and `oidc.ts`) that reads the
 * session's token container; every other reader goes through `getFreshAccessToken` or the
 * request context (pinned by `tokenReaders.pin.spec.js`).
 */
const { configureTokenSource, getTokenSource, getFreshAccessToken } = require('./tokenSource');
const { withSessionLock, isLocked } = require('./refreshLock');
const { SovereignSessionError } = require('./SovereignSessionError');
const { handleSovereignTerminalFailure } = require('./terminalFailure');
const {
  SOVEREIGN_SESSION_FAILURE_CODES,
  messageForSovereignFailure,
  isSovereignSessionFailure,
} = require('./sessionFailureMessages');

module.exports = {
  configureTokenSource,
  getTokenSource,
  getFreshAccessToken,
  withSessionLock,
  isLocked,
  SovereignSessionError,
  handleSovereignTerminalFailure,
  SOVEREIGN_SESSION_FAILURE_CODES,
  messageForSovereignFailure,
  isSovereignSessionFailure,
};
