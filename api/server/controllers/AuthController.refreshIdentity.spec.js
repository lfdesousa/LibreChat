/**
 * CONSOLE-LONG-TURN-TOKEN-REFRESH ADDENDUM-2 — B2 remainder (gate r2 S1): refreshController uses the STRATEGY's verifier.
 * Supersedes ADDENDUM-1's `RED.AuthController.refreshIdentity.spec.js` (same destination): R6', R7', R8, R9, R24 unchanged;
 * the `~/strategies` mock now carries `verifyOpenIdAccessToken` (the contract: refreshController imports it from `~/strategies`),
 * implemented here as a real RS256 verification with the test key + issuer + azp; R25c/R26c pin the controller's 401 when
 * that verifier rejects. Neuters: "drop the sub check" → R8 RED; "use getValidOpenIDReuseUserId as-is" → R9 RED;
 * "decode instead of verify" → the verifier suite (R25b) RED, and R25c/R26c here RED when the controller stops calling it.
 */
jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), debug: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));
jest.mock('~/server/services/GraphTokenService', () => ({ getGraphApiToken: jest.fn() }));
jest.mock('~/server/services/AuthService', () => ({
  requestPasswordReset: jest.fn(),
  setOpenIDAuthTokens: jest.fn(),
  storeOpenIDSession: jest.fn(),
  setCloudFrontAuthCookies: jest.fn(),
  resetPassword: jest.fn(),
  setAuthTokens: jest.fn(),
  registerUser: jest.fn(),
}));
const verifierState = { publicPem: null, issuer: null, clientId: null };
jest.mock('~/strategies', () => {
  const jsonwebtoken = require('jsonwebtoken');
  return {
    getOpenIdConfig: jest.fn(),
    getOpenIdEmail: jest.fn(),
    // the contract: the strategy's verifier (JWKS signature, issuer allow-list, azp === client)
    verifyOpenIdAccessToken: jest.fn(async (token) => {
      const payload = jsonwebtoken.verify(token, verifierState.publicPem, {
        algorithms: ['RS256'],
      });
      if (payload.iss !== verifierState.issuer) throw new Error('issuer not allowed');
      if (payload.azp !== verifierState.clientId) throw new Error('azp mismatch');
      return payload;
    }),
  };
});
jest.mock('openid-client', () => ({ refreshTokenGrant: jest.fn() }));
jest.mock('jwks-rsa', () => jest.fn(() => ({ getSigningKey: jest.fn() })));
jest.mock('~/models', () => ({
  deleteAllUserSessions: jest.fn(),
  getUserById: jest.fn(),
  findSession: jest.fn(),
  updateUser: jest.fn(),
  findUser: jest.fn(),
}));
jest.mock('@librechat/api', () => {
  const jsonwebtoken = require('jsonwebtoken');
  return {
    OPENID_EXPIRY_BUFFER_SECONDS: 30,
    math: jest.fn((value, fallback) => fallback),
    isEnabled: jest.fn(() => true),
    findOpenIDUser: jest.fn(),
    getOpenIdIssuer: jest.fn(() => 'https://issuer.example.test/realms/audittrace'),
    buildOpenIDRefreshParams: jest.fn(() => ({ scope: 'openid profile email' })),
    getValidOpenIdReuseUserId: (openidUserId, secret = process.env.JWT_REFRESH_SECRET) => {
      if (!openidUserId || !secret) return null;
      try {
        const payload = jsonwebtoken.verify(openidUserId, secret);
        return typeof payload === 'object' && payload != null && typeof payload.id === 'string'
          ? payload.id
          : null;
      } catch {
        return null;
      }
    },
  };
});

const { createHash, generateKeyPairSync } = require('crypto');
const jwt = require('jsonwebtoken');
const openIdClient = require('openid-client');
const { logger } = require('@librechat/data-schemas');
const { findOpenIDUser } = require('@librechat/api');
const { refreshController } = require('./AuthController');
const { setOpenIDAuthTokens, storeOpenIDSession } = require('~/server/services/AuthService');
const { getOpenIdConfig, verifyOpenIdAccessToken } = require('~/strategies');
const { getUserById } = require('~/models');

const ISSUER = 'https://issuer.example.test/realms/audittrace';
const CLIENT = 'audittrace-librechat';
const keyA = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyB = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = (k, type) => k.export({ type, format: 'pem' });
const T0_S = Math.floor(Date.UTC(2026, 10, 25, 13, 41, 55) / 1000);
const signAccess = (sub, { key = keyA, iss = ISSUER, azp = CLIENT } = {}) =>
  jwt.sign(
    {
      sub,
      iss,
      azp,
      aud: ['audittrace-server', 'account'],
      exp: T0_S + 300,
      iat: T0_S,
      typ: 'Bearer',
    },
    pem(key.privateKey, 'pkcs8'),
    { algorithm: 'RS256', keyid: 'kid-1', noTimestamp: true },
  );
const SUB_A = 'kc-sub-A';
const SUB_B = 'kc-sub-B';
const USER_A = {
  _id: { toString: () => 'user-A' },
  id: 'user-A',
  email: 'a@example.test',
  openidId: SUB_A,
  tenantId: undefined,
};
const PRESENTED_RT = 'rt-0';
const hashOf = (rt) => createHash('sha256').update(rt).digest('base64url');
const envBefore = { ...process.env };

function cookieHeader({ bindingFor }) {
  const parts = ['token_provider=openid', `refreshToken=${PRESENTED_RT}`];
  if (bindingFor) {
    parts.push(
      `openid_user_id=${jwt.sign({ id: 'user-A', refreshTokenHash: hashOf(bindingFor) }, process.env.JWT_REFRESH_SECRET, { expiresIn: 3600 })}`,
    );
  }
  return parts.join('; ');
}
function mockRes() {
  const res = {};
  for (const k of ['status', 'send', 'json', 'redirect', 'cookie']) res[k] = jest.fn(() => res);
  return res;
}
function refreshAnswers(accessToken) {
  openIdClient.refreshTokenGrant.mockResolvedValue({
    access_token: accessToken,
    refresh_token: 'rt-1',
    expires_in: 300,
    token_type: 'Bearer',
    claims: () => undefined,
  });
}
const boundReq = () => ({
  headers: { cookie: cookieHeader({ bindingFor: PRESENTED_RT }) },
  session: { openidTokens: { refreshToken: PRESENTED_RT } },
});
const expect401 = (res) => {
  expect(res.status).toHaveBeenCalledWith(401);
  expect(res.status).not.toHaveBeenCalledWith(200);
  expect(res.status).not.toHaveBeenCalledWith(403);
  expect(storeOpenIDSession).not.toHaveBeenCalled();
  expect(setOpenIDAuthTokens).not.toHaveBeenCalled();
};

describe('CONSOLE-LONG-TURN-TOKEN-REFRESH ADDENDUM-2 — refreshController identity without an id_token (strategy verifier)', () => {
  let nowSpy;
  beforeEach(() => {
    jest.clearAllMocks();
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => (T0_S + 5) * 1000);
    process.env.JWT_REFRESH_SECRET = 'unit-only-refresh-secret';
    process.env.OPENID_REUSE_TOKENS = 'true';
    process.env.OPENID_CLIENT_ID = CLIENT;
    verifierState.publicPem = pem(keyA.publicKey, 'spki');
    verifierState.issuer = ISSUER;
    verifierState.clientId = CLIENT;
    getOpenIdConfig.mockReturnValue({
      clientId: CLIENT,
      serverMetadata: () => ({ jwks_uri: 'https://issuer.example.test/jwks', issuer: ISSUER }),
    });
    getUserById.mockResolvedValue(USER_A);
    findOpenIDUser.mockResolvedValue({ user: USER_A, error: null, migration: false });
    setOpenIDAuthTokens.mockReturnValue('app-token-after-refresh');
  });
  afterEach(() => {
    nowSpy.mockRestore();
    process.env = { ...envBefore };
  });

  it("R6' — binding to the presented refresh token and a verified sub equal to the bound openidId: 200 with the new token", async () => {
    refreshAnswers(signAccess(SUB_A));
    const res = mockRes();
    await refreshController(boundReq(), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'app-token-after-refresh' }),
    );
    expect(verifyOpenIdAccessToken).toHaveBeenCalledTimes(1);
    expect(storeOpenIDSession).toHaveBeenCalledWith('user-A', 'rt-1', undefined, PRESENTED_RT);
    expect(
      logger.error.mock.calls.some((c) => String(c[0]).includes('OpenID token refresh error')),
    ).toBe(false);
  });

  it("R7' — no binding at all: 401 -> /login, never a 403 crash, nothing stored", async () => {
    refreshAnswers(signAccess(SUB_A));
    const res = mockRes();
    await refreshController(
      {
        headers: { cookie: cookieHeader({ bindingFor: null }) },
        session: { openidTokens: { refreshToken: PRESENTED_RT } },
      },
      res,
    );
    expect401(res);
    expect(res.redirect).toHaveBeenCalledWith('/login');
  });

  it('R8 — binding for user A, the refreshed token carries subject B: 401, nothing stored (neuter: drop the sub check)', async () => {
    refreshAnswers(signAccess(SUB_B));
    const res = mockRes();
    await refreshController(boundReq(), res);
    expect(verifyOpenIdAccessToken).toHaveBeenCalledTimes(1);
    expect401(res);
  });

  it('R9 — a signed binding whose hash names ANOTHER refresh token than the one presented: 401 (neuter: helper as-is)', async () => {
    refreshAnswers(signAccess(SUB_A));
    const res = mockRes();
    await refreshController(
      {
        headers: { cookie: cookieHeader({ bindingFor: 'rt-of-someone-else' }) },
        session: { openidTokens: { refreshToken: PRESENTED_RT } },
      },
      res,
    );
    expect(res.send).not.toHaveBeenCalled();
    expect401(res);
  });

  it('R24 — after a mid-turn rotation the session holds userId + the NEW refresh token while the cookie hash names the old one: 200', async () => {
    refreshAnswers(signAccess(SUB_A));
    const res = mockRes();
    await refreshController(
      {
        headers: { cookie: cookieHeader({ bindingFor: 'rt-0' }) },
        session: { openidTokens: { userId: 'user-A', refreshToken: 'rt-7' } },
      },
      res,
    );
    expect(openIdClient.refreshTokenGrant.mock.calls[0][1]).toBe('rt-7');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.status).not.toHaveBeenCalledWith(401);
    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  it('R25c — the refreshed access token is signed by ANOTHER key: the verifier rejects, the controller answers 401, nothing stored', async () => {
    refreshAnswers(signAccess(SUB_A, { key: keyB }));
    const res = mockRes();
    await refreshController(boundReq(), res);
    expect(verifyOpenIdAccessToken).toHaveBeenCalledTimes(1);
    expect401(res);
  });

  it('R26c — the refreshed access token names the wrong issuer: 401, nothing stored', async () => {
    refreshAnswers(signAccess(SUB_A, { iss: 'https://evil.example.test/realms/audittrace' }));
    const res = mockRes();
    await refreshController(boundReq(), res);
    expect(verifyOpenIdAccessToken).toHaveBeenCalledTimes(1);
    expect401(res);
  });
});
