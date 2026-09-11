const {
  restoreRequestAccessTokenContext,
  getRequestAccessToken,
  runWithRequestAccessToken,
} = require('./requestContext');

describe('restoreRequestAccessTokenContext (MongoDB-elimination WU-2b)', () => {
  it('establishes the access-token context from req.session/req.user, mirroring restoreTenantContextFromReq', () => {
    const req = {
      user: { id: 'user-1' },
      session: { openidTokens: { accessToken: 'tok-after-multer' } },
    };
    let observed;
    restoreRequestAccessTokenContext(req, {}, () => {
      observed = getRequestAccessToken();
    });
    expect(observed).toBe('tok-after-multer');
  });

  it('re-establishes the context correctly even if it was lost (e.g. across multer)', () => {
    // Simulate the "lost across a stream boundary" scenario: no context is
    // active when this middleware runs (as if multer's raw stream handling
    // dropped it), yet it still re-derives the token from req.
    expect(getRequestAccessToken()).toBeUndefined();
    const req = {
      user: { id: 'user-1' },
      session: { openidTokens: { accessToken: 'restored-token' } },
    };
    let observed;
    restoreRequestAccessTokenContext(req, {}, () => {
      observed = getRequestAccessToken();
    });
    expect(observed).toBe('restored-token');
  });

  it('a request with no session establishes an empty (undefined-token) context, not a stale one', () => {
    let observed = 'not-set';
    runWithRequestAccessToken({ accessToken: 'stale-outer-token' }, () => {
      const req = { user: { id: 'user-2' } };
      restoreRequestAccessTokenContext(req, {}, () => {
        observed = getRequestAccessToken();
      });
    });
    expect(observed).toBeUndefined();
  });
});
