/**
 * The mapping of a failed refresh grant onto the four named failures (operator ruling "Expired vs
 * ended", ADDENDUM-1 S1). One row per class; the neuter of each row is the mapping change that
 * collapses it into another code.
 */
const { classifyRefreshFailure } = require('../classifyRefreshFailure');

const oauth = (error, description, status = 400) =>
  Object.assign(new Error(error), { error, error_description: description, status });

describe('AuditTraceAuth/classifyRefreshFailure', () => {
  it.each([['Session not active'], ["Session doesn't have required client"]])(
    'invalid_grant naming the session (%s) is `sovereign_sso_session_ended` (401)',
    (description) => {
      const failure = classifyRefreshFailure(oauth('invalid_grant', description));
      expect(failure.code).toBe('sovereign_sso_session_ended');
      expect(failure.status).toBe(401);
    },
  );

  it.each([
    ['invalid_grant', 'Invalid refresh token'],
    ['invalid_grant', 'Stale refresh token'],
    ['invalid_grant', 'Token is not active'],
    ['invalid_grant', undefined],
    ['invalid_client', 'Invalid client or Invalid client credentials'],
    ['invalid_scope', 'Invalid scopes'],
    ['unauthorized_client', 'Invalid client secret'],
  ])('%s / %s is `sovereign_refresh_token_rejected` (401)', (error, description) => {
    const failure = classifyRefreshFailure(oauth(error, description));
    expect(failure.code).toBe('sovereign_refresh_token_rejected');
    expect(failure.status).toBe(401);
  });

  it.each([
    ['a transport error', new TypeError('fetch failed')],
    ['a timeout', Object.assign(new Error('timeout'), { name: 'TimeoutError' })],
    ['a 5xx from the token endpoint', oauth('temporarily_unavailable', undefined, 503)],
    ['a non-OAuth answer', Object.assign(new Error('bad json'), { status: 400 })],
    ['nothing at all', undefined],
  ])('%s is `sovereign_refresh_failed` (502)', (_label, error) => {
    const failure = classifyRefreshFailure(error);
    expect(failure.code).toBe('sovereign_refresh_failed');
    expect(failure.status).toBe(502);
  });

  it('never carries the Keycloak body into the message', () => {
    const failure = classifyRefreshFailure(
      oauth('invalid_grant', 'Invalid refresh token eyJhbGciOi.secret.signature'),
    );
    expect(failure.message).not.toContain('eyJhbGciOi');
    expect(failure.message).not.toContain('secret');
  });
});
