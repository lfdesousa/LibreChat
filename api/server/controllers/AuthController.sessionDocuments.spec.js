/**
 * F1 (review r1) / ADDENDUM-2 A2: the Session documents (one per refresh token) a long turn leaves behind.
 * A fake document store with the real semantics (`storeOpenIDSession` upserts the new token and deletes the
 * previous one; `deleteOpenIDSessionDocument` deletes one) is shared by the mid-turn token source and
 * `refreshController`. The browser's cookie keeps naming the LOGIN refresh token (rt-0) throughout.
 * Neuters: the source passes no previous token -> the "at most 2" and "only rt-2" cells go RED;
 * the controller never deletes the cookie-named document -> "only rt-2" goes RED.
 */
jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), debug: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));
jest.mock('~/server/services/GraphTokenService', () => ({ getGraphApiToken: jest.fn() }));
const mockDocs = new Set();
jest.mock('~/server/services/AuthService', () => ({
  requestPasswordReset: jest.fn(),
  resetPassword: jest.fn(),
  setAuthTokens: jest.fn(),
  registerUser: jest.fn(),
  setCloudFrontAuthCookies: jest.fn(),
  setOpenIDAuthTokens: jest.fn((tokenset, req) => {
    req.session.openidTokens = {
      ...req.session.openidTokens,
      accessToken: tokenset.access_token,
      refreshToken: tokenset.refresh_token,
      lastRefreshedAt: Date.now(),
    };
    return 'app-token';
  }),
  storeOpenIDSession: jest.fn(async (_userId, refreshToken, _tenantId, previousRefreshToken) => {
    mockDocs.add(refreshToken);
    if (previousRefreshToken && previousRefreshToken !== refreshToken) {
      mockDocs.delete(previousRefreshToken);
    }
  }),
  deleteOpenIDSessionDocument: jest.fn(async (refreshToken) => {
    mockDocs.delete(refreshToken);
  }),
}));
jest.mock('~/strategies', () => ({
  getOpenIdConfig: jest.fn(() => ({ clientId: 'audittrace-librechat' })),
  getOpenIdEmail: jest.fn(() => 'u@example.test'),
  verifyOpenIdAccessToken: jest.fn(),
}));
jest.mock('openid-client', () => ({ refreshTokenGrant: jest.fn() }));
jest.mock('~/models', () => ({
  deleteAllUserSessions: jest.fn(),
  getUserById: jest.fn(),
  findSession: jest.fn(),
  updateUser: jest.fn(),
  findUser: jest.fn(),
}));
jest.mock('@librechat/api', () => ({
  OPENID_EXPIRY_BUFFER_SECONDS: 30,
  math: jest.fn((value, fallback) => fallback),
  isEnabled: jest.fn(() => true),
  findOpenIDUser: jest.fn(),
  getOpenIdIssuer: jest.fn(() => 'https://issuer.example.test/realms/audittrace'),
  buildOpenIDRefreshParams: jest.fn(() => ({ scope: 'openid' })),
}));

const jwt = require('jsonwebtoken');
const openIdClient = require('openid-client');
const { findOpenIDUser } = require('@librechat/api');
const { configureTokenSource, getTokenSource } = require('~/server/services/AuditTraceAuth');
const { storeOpenIDSession } = require('~/server/services/AuthService');
const { refreshController } = require('./AuthController');

const T0_MS = Date.UTC(2026, 10, 25, 13, 41, 55);
const SUB = 'kc-sub-0001';
const USER = {
  _id: { toString: () => 'user-1' },
  id: 'user-1',
  openidId: SUB,
  email: 'u@example.test',
};
const clock = { ms: T0_MS };
const nowS = () => Math.floor(clock.ms / 1000);
const makeToken = (expS) =>
  jwt.sign({ sub: SUB, exp: expS }, 'unit-only-secret', { noTimestamp: true });
const mockRes = () => {
  const res = {};
  for (const k of ['status', 'send', 'json', 'redirect', 'cookie']) res[k] = jest.fn(() => res);
  return res;
};

describe('Session documents after mid-turn rotations (A2, review r1 F1)', () => {
  let nowSpy;
  let session;
  let n;
  const envBefore = { ...process.env };

  /** The Keycloak double: rotates the refresh token on every grant. */
  const rotatingKeycloak = () => {
    n = 0;
    openIdClient.refreshTokenGrant.mockImplementation(async () => {
      n += 1;
      return {
        access_token: makeToken(nowS() + 300),
        refresh_token: `rt-${n}`,
        expires_in: 300,
        claims: () => ({ sub: SUB }),
      };
    });
  };
  /** A request of the browser's session: the cookie names the login token rt-0. */
  const request = () => ({
    sessionID: 'sess-docs',
    session,
    user: { id: 'user-1', openidId: SUB },
    headers: { cookie: 'token_provider=openid; refreshToken=rt-0' },
  });
  const advance = (seconds) => {
    clock.ms += seconds * 1000;
  };
  const midTurnRefresh = () => getTokenSource(request()).current();

  beforeEach(() => {
    jest.clearAllMocks();
    clock.ms = T0_MS;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => clock.ms);
    process.env.OPENID_REUSE_TOKENS = 'true';
    process.env.JWT_REFRESH_SECRET = 'unit-only-refresh-secret';
    mockDocs.clear();
    mockDocs.add('rt-0');
    session = {
      openidTokens: {
        accessToken: makeToken(nowS() + 300),
        refreshToken: 'rt-0',
        lastRefreshedAt: clock.ms,
        userId: 'user-1',
      },
    };
    findOpenIDUser.mockResolvedValue({ user: USER, error: null, migration: false });
    configureTokenSource({
      getOpenIdConfig: () => ({}),
      verifyOpenIdAccessToken: jest.fn(),
      storeOpenIDSession: (...args) => storeOpenIDSession(...args),
    });
    rotatingKeycloak();
  });
  afterEach(() => {
    nowSpy.mockRestore();
    process.env = { ...envBefore };
  });

  it('rt-0 -> rt-1 mid-turn, then the browser refreshes (cookie rt-0): only rt-2 has a document', async () => {
    advance(280);
    await midTurnRefresh();
    expect([...mockDocs].sort()).toEqual(['rt-0', 'rt-1']);
    advance(280);
    const res = mockRes();
    await refreshController(request(), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(session.openidTokens.refreshToken).toBe('rt-2');
    expect([...mockDocs]).toEqual(['rt-2']);
  });

  it.each([2, 5])(
    '%i mid-turn refreshes leave at most two documents: the cookie-named one and the current one',
    async (k) => {
      for (let i = 0; i < k; i += 1) {
        advance(280);
        await midTurnRefresh();
        expect(mockDocs.size).toBeLessThanOrEqual(2);
      }
      expect([...mockDocs].sort()).toEqual(['rt-0', `rt-${k}`]);
    },
  );
});
