/**
 * Edges of the request token source that the long-turn suite does not reach: when no source exists,
 * what is final and what is retried, and which failure each verifier error becomes (ADDENDUM-2 A3).
 * Clock: a `Date.now` stub; no wall-clock wait decides anything.
 */
jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('@librechat/api', () => ({
  OPENID_EXPIRY_BUFFER_SECONDS: 30,
  buildOpenIDRefreshParams: jest.fn(() => ({ scope: 'openid' })),
}));
jest.mock('openid-client', () => ({ refreshTokenGrant: jest.fn() }));
const mockVerify = jest.fn();
jest.mock('~/strategies', () => ({
  getOpenIdConfig: jest.fn(() => ({ clientId: 'audittrace-librechat' })),
  verifyOpenIdAccessToken: (...args) => mockVerify(...args),
}));
jest.mock('~/server/services/AuthService', () => ({ storeOpenIDSession: jest.fn() }));

const jwt = require('jsonwebtoken');
const openIdClient = require('openid-client');
const { logger } = require('@librechat/data-schemas');
const { storeOpenIDSession } = require('~/server/services/AuthService');
const { getTokenSource, getFreshAccessToken, configureTokenSource } = require('../tokenSource');
const { isLocked } = require('../refreshLock');

const T0_MS = Date.UTC(2026, 10, 25, 13, 41, 55);
const SUB = 'kc-sub-0001';
const clock = { ms: T0_MS };
const nowS = () => Math.floor(clock.ms / 1000);
const makeToken = (expS) =>
  jwt.sign({ sub: SUB, exp: expS }, 'unit-only-secret', { noTimestamp: true });
const grantAnswer = ({ claims = { sub: SUB } } = {}) => ({
  access_token: makeToken(nowS() + 300),
  refresh_token: 'rt-1',
  expires_in: 300,
  claims: () => claims,
});

const requestWith = ({ accessToken = makeToken(nowS() + 300), user, saveError } = {}) => {
  const req = {
    sessionID: 'sess-edge',
    user: user ?? { id: 'user-1', openidId: SUB },
    session: {
      openidTokens: { accessToken, refreshToken: 'rt-0', lastRefreshedAt: clock.ms },
      reload: jest.fn((cb) => cb()),
      save: jest.fn((cb) => cb(saveError)),
    },
  };
  return req;
};
configureTokenSource({
  getOpenIdConfig: () => require('~/strategies').getOpenIdConfig(),
  verifyOpenIdAccessToken: (...args) => require('~/strategies').verifyOpenIdAccessToken(...args),
  storeOpenIDSession: (...args) =>
    require('~/server/services/AuthService').storeOpenIDSession(...args),
});
const expire = () => {
  clock.ms = T0_MS + 310 * 1000;
};
const failureOf = (p) =>
  p.then(
    () => null,
    (e) => e,
  );

describe('AuditTraceAuth/tokenSource', () => {
  let nowSpy;
  beforeEach(() => {
    jest.clearAllMocks();
    clock.ms = T0_MS;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => clock.ms);
  });
  afterEach(() => nowSpy.mockRestore());

  it('there is no source for a request without an OpenID session token, and one source per request otherwise', async () => {
    expect(getTokenSource({})).toBeUndefined();
    expect(getTokenSource({ session: { openidTokens: {} } })).toBeUndefined();
    await expect(getFreshAccessToken({ session: {} })).resolves.toBeUndefined();
    const req = requestWith();
    expect(getTokenSource(req)).toBe(getTokenSource(req));
  });

  it('a source that was never configured cannot refresh: fail closed as `sovereign_refresh_failed`, the grant never runs', async () => {
    let unconfigured;
    jest.isolateModules(() => {
      unconfigured = require('../tokenSource');
    });
    const req = requestWith();
    expire();
    const failure = await failureOf(unconfigured.getTokenSource(req).current());
    expect(failure.code).toBe('sovereign_refresh_failed');
    expect(failure.detail).toBe('token_source_not_configured');
    expect(openIdClient.refreshTokenGrant).not.toHaveBeenCalled();
  });

  it('an opaque or exp-less access token is returned as is: it is never judged, never refreshed', async () => {
    const req = requestWith({ accessToken: 'opaque-token' });
    expire();
    await expect(getTokenSource(req).current()).resolves.toBe('opaque-token');
    expect(openIdClient.refreshTokenGrant).not.toHaveBeenCalled();
  });

  it('a final refusal is remembered for the request: the dead refresh token is presented once', async () => {
    openIdClient.refreshTokenGrant.mockRejectedValue(
      Object.assign(new Error('invalid_grant'), {
        error: 'invalid_grant',
        error_description: 'Session not active',
        status: 400,
      }),
    );
    const source = getTokenSource(requestWith());
    expire();
    const first = await failureOf(source.current());
    const second = await failureOf(source.current());
    expect(first.code).toBe('sovereign_sso_session_ended');
    expect(second).toBe(first);
    expect(openIdClient.refreshTokenGrant).toHaveBeenCalledTimes(1);
    expect(isLocked('sess-edge')).toBe(false);
  });

  it('a transient failure is not remembered: the next call asks Keycloak again', async () => {
    openIdClient.refreshTokenGrant
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(grantAnswer());
    const source = getTokenSource(requestWith());
    expire();
    const failure = await failureOf(source.current());
    expect(failure.code).toBe('sovereign_refresh_failed');
    await expect(source.current()).resolves.toEqual(expect.any(String));
    expect(openIdClient.refreshTokenGrant).toHaveBeenCalledTimes(2);
  });

  it('the refresh is logged by count and expiry only', async () => {
    openIdClient.refreshTokenGrant.mockResolvedValue(grantAnswer());
    const req = requestWith();
    expire();
    await getTokenSource(req).current();
    expect(logger.info).toHaveBeenCalledWith('[sovereign-token] refreshed', {
      refresh_count: 1,
      expires_in: 300,
    });
  });

  it('a session save failure is `sovereign_refresh_failed` (session_save_failed): the new tokens were not persisted', async () => {
    openIdClient.refreshTokenGrant.mockResolvedValue(grantAnswer());
    const req = requestWith({ saveError: new Error('store down') });
    expire();
    const failure = await failureOf(getTokenSource(req).current());
    expect(failure.code).toBe('sovereign_refresh_failed');
    expect(failure.detail).toBe('session_save_failed');
  });

  it('a failing Session-document write does not fail the call: the tokens are already saved in the Express session', async () => {
    openIdClient.refreshTokenGrant.mockResolvedValue(grantAnswer());
    storeOpenIDSession.mockRejectedValueOnce(new Error('mongo down'));
    const req = requestWith();
    expire();
    await expect(getTokenSource(req).current()).resolves.toEqual(expect.any(String));
    expect(req.session.openidTokens.refreshToken).toBe('rt-1');
    expect(logger.warn).toHaveBeenCalledWith(
      '[sovereign-token] refresh session document not stored',
    );
  });

  it("the replaced token's Session document is kept when the browser's cookie still names it (A2)", async () => {
    openIdClient.refreshTokenGrant.mockResolvedValue(grantAnswer());
    const req = requestWith();
    req.headers = { cookie: 'token_provider=openid; refreshToken=rt-0' };
    expire();
    await getTokenSource(req).current();
    expect(storeOpenIDSession).toHaveBeenCalledWith('user-1', 'rt-1', undefined, undefined);
  });

  it("the replaced token's Session document is deleted when the cookie names another token", async () => {
    openIdClient.refreshTokenGrant.mockResolvedValue(grantAnswer());
    const req = requestWith();
    req.headers = { cookie: 'token_provider=openid; refreshToken=rt-login' };
    expire();
    await getTokenSource(req).current();
    expect(storeOpenIDSession).toHaveBeenCalledWith('user-1', 'rt-1', undefined, 'rt-0');
  });

  it("a request without cookies deletes the replaced token's document", async () => {
    openIdClient.refreshTokenGrant.mockResolvedValue(grantAnswer());
    const req = requestWith();
    expire();
    await getTokenSource(req).current();
    expect(storeOpenIDSession).toHaveBeenCalledWith('user-1', 'rt-1', undefined, 'rt-0');
  });

  describe('identity after a grant without an id_token (A3)', () => {
    const noClaims = () => grantAnswer({ claims: null });

    it('a verified access token of the bound subject is accepted', async () => {
      openIdClient.refreshTokenGrant.mockResolvedValue(noClaims());
      mockVerify.mockResolvedValue({ sub: SUB });
      const req = requestWith();
      expire();
      await expect(getTokenSource(req).current()).resolves.toEqual(expect.any(String));
      expect(mockVerify).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['a signature, issuer or azp refusal', 'JsonWebTokenError', 'identity_mismatch'],
      ['an unknown signing key', 'SigningKeyNotFoundError', 'identity_mismatch'],
      ['an unreachable JWKS', 'JwksError', 'jwks_unreachable'],
      ['a transport error', 'TypeError', 'jwks_unreachable'],
    ])('%s is `sovereign_refresh_failed` (502), detail %s -> %s', async (_label, name, detail) => {
      openIdClient.refreshTokenGrant.mockResolvedValue(noClaims());
      mockVerify.mockRejectedValue(Object.assign(new Error('verifier'), { name }));
      const req = requestWith();
      const before = req.session.openidTokens.accessToken;
      expire();
      const failure = await failureOf(getTokenSource(req).current());
      expect(failure.code).toBe('sovereign_refresh_failed');
      expect(failure.status).toBe(502);
      expect(failure.detail).toBe(detail);
      expect(req.session.openidTokens.accessToken).toBe(before);
    });

    it('a request user without an `openidId` cannot be matched: fail closed, session untouched', async () => {
      openIdClient.refreshTokenGrant.mockResolvedValue(grantAnswer());
      const req = requestWith({ user: { id: 'user-1' } });
      const before = req.session.openidTokens.accessToken;
      expire();
      const failure = await failureOf(getTokenSource(req).current());
      expect(failure.detail).toBe('identity_mismatch');
      expect(req.session.openidTokens.accessToken).toBe(before);
    });
  });
});
