const {
  SSO_SESSION_ENDED,
  REFRESH_TOKEN_REJECTED,
  REFRESH_FAILED,
} = require('./sessionFailureMessages');
const { SovereignSessionError } = require('./SovereignSessionError');

/** Keycloak's `error_description` for a session that is gone ("Session not active", "Session doesn't have required client"). */
const SESSION_DESCRIPTION = /\bsession\b/i;

/**
 * Maps a failed `refreshTokenGrant` onto one of the named failures, never carrying the
 * Keycloak body or any token into the message.
 *
 *  - an OAuth refusal (4xx with an `error` code) is final for this refresh token:
 *    `invalid_grant` naming the session -> `sovereign_sso_session_ended` (the SSO session was
 *    ended early); every other refusal -> `sovereign_refresh_token_rejected`;
 *  - transport errors, timeouts, 5xx and non-OAuth answers -> `sovereign_refresh_failed` (502).
 *
 * @param {unknown} error
 * @returns {SovereignSessionError}
 */
function classifyRefreshFailure(error) {
  const e = /** @type {{error?: unknown, error_description?: unknown, status?: unknown}} */ (
    error ?? {}
  );
  const status = typeof e.status === 'number' ? e.status : undefined;
  const isOAuthRefusal =
    typeof e.error === 'string' && status !== undefined && status >= 400 && status < 500;
  if (!isOAuthRefusal) {
    return new SovereignSessionError({
      code: REFRESH_FAILED,
      status: 502,
      detail: 'token_endpoint',
    });
  }
  if (
    e.error === 'invalid_grant' &&
    typeof e.error_description === 'string' &&
    SESSION_DESCRIPTION.test(e.error_description)
  ) {
    return new SovereignSessionError({
      code: SSO_SESSION_ENDED,
      status: 401,
      detail: 'invalid_grant',
    });
  }
  return new SovereignSessionError({
    code: REFRESH_TOKEN_REJECTED,
    status: 401,
    detail: /** @type {string} */ (e.error),
  });
}

module.exports = { classifyRefreshFailure };
