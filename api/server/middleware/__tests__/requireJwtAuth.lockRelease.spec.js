/**
 * CONSOLE-LONG-TURN-TOKEN-REFRESH ADDENDUM-2 — A3 and A4 (gate r2).
 *  R28 — the per-session lock is released on EVERY path: after a failed grant (`sovereign_refresh_failed`) the lock table has
 *        no entry for the session (`isLocked`, structural; gate r3 S2 replaced the 2 s timer race), and the next caller
 *        acquires the lock and grants.
 *  R29 — a mid-turn refresh whose new access token carries ANOTHER subject than the bound `openidId` is refused as
 *        `sovereign_refresh_failed` (502, detail `identity_mismatch`); the session is NOT overwritten with the foreign tokens.
 * Harness as in ADDENDUM-1's v2 long-turn file (Date.now stub, Keycloak + session-store doubles).
 */
jest.mock('passport', () => ({
  _strategy: jest.fn(() => ({})),
  authenticate: jest.fn(
    (strategy, _options, callback) => (req) =>
      callback(null, req._mockUser ?? false, undefined, req._mockUser ? undefined : 401),
  ),
}));
jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('@librechat/api', () => ({
  OPENID_EXPIRY_BUFFER_SECONDS: 30,
  isEnabled: jest.fn((v) => String(v).toLowerCase() === 'true'),
  math: jest.fn((value, fallback) => fallback),
  recordRumProxyRequest: jest.fn(),
  getAuthFailureReasonCategory: jest.fn(() => 'missing_or_unrecognized_token'),
  buildSafeAuthLogContext: jest.fn(() => ({})),
  getValidOpenIdReuseUserId: jest.fn(() => null),
  maybeRefreshCloudFrontAuthCookiesMiddleware: (req, res, next) => next(),
  tenantContextMiddleware: (req, res, next) => next(),
  buildOpenIDRefreshParams: jest.fn(() => ({ scope: 'openid profile email' })),
  findOpenIDUser: jest.fn(),
  getOpenIdIssuer: jest.fn(() => 'https://issuer.example.test/realms/audittrace'),
}));
jest.mock('openid-client', () => ({ refreshTokenGrant: jest.fn() }));
jest.mock('jwks-rsa', () => jest.fn(() => ({ getSigningKey: jest.fn() })));
jest.mock('~/strategies', () => {
  const jsonwebtoken = require('jsonwebtoken');
  return {
    getOpenIdConfig: jest.fn(() => ({
      clientId: 'audittrace-librechat',
      serverMetadata: () => ({
        jwks_uri: 'https://issuer.example.test/jwks',
        issuer: 'https://issuer.example.test/realms/audittrace',
      }),
    })),
    getOpenIdEmail: jest.fn(),
    // the strategy's verifier, as mocked in the identity suite: the unit tokens are HS256 'unit-only-secret' here
    verifyOpenIdAccessToken: jest.fn(async (token) =>
      jsonwebtoken.verify(token, 'unit-only-secret', { algorithms: ['HS256'] }),
    ),
  };
});
jest.mock('~/server/services/AuthService', () => ({
  storeOpenIDSession: jest.fn(async () => undefined),
  setOpenIDAuthTokens: jest.fn(),
  setCloudFrontAuthCookies: jest.fn(),
}));
jest.mock('axios', () => ({ request: jest.fn() }));

const jwt = require('jsonwebtoken');
const openIdClient = require('openid-client');
const requireJwtAuth = require('../requireJwtAuth');
const { getRequestAccessToken } = require('../../services/AuditTraceConversations/requestContext');
const { isLocked } = require('../../services/AuditTraceAuth/refreshLock');

const LIFETIME_S = 300;
const BUFFER_S = 30;
const T0_MS = Date.UTC(2026, 10, 25, 13, 41, 55);
const SUB = 'kc-sub-0001';
const clock = { ms: T0_MS };
const nowS = () => Math.floor(clock.ms / 1000);
const makeToken = (expS, sub = SUB) =>
  jwt.sign({ sub, exp: expS, iat: nowS() }, 'unit-only-secret', { noTimestamp: true });
const expOf = (t) => jwt.decode(t).exp;

function sessionStore() {
  const store = { records: {} };
  store.attach = (req, sessionID) => {
    const make = () => {
      const data = store.records[sessionID];
      return {
        id: sessionID,
        openidTokens: data ? JSON.parse(JSON.stringify(data.openidTokens)) : undefined,
        save: jest.fn((cb) => {
          store.records[sessionID] = {
            openidTokens: JSON.parse(JSON.stringify(req.session.openidTokens)),
          };
          if (typeof cb === 'function') cb();
          return Promise.resolve();
        }),
        reload: jest.fn((cb) => {
          req.session = make();
          if (typeof cb === 'function') cb();
          return Promise.resolve();
        }),
      };
    };
    req.sessionID = sessionID;
    req.session = make();
    return req;
  };
  return store;
}
function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}
function withAuthenticatedRequest(req, body) {
  return new Promise((resolve, reject) => {
    requireJwtAuth(req, mockRes(), () => Promise.resolve().then(body).then(resolve, reject));
  });
}

describe('CONSOLE-LONG-TURN-TOKEN-REFRESH ADDENDUM-2 — lock release and identity after a mid-turn refresh', () => {
  let nowSpy, store;
  const envBefore = { ...process.env };
  beforeEach(() => {
    jest.clearAllMocks();
    clock.ms = T0_MS;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => clock.ms);
    process.env.AUDITTRACE_MEMORY_BACKEND = 'sovereign';
    process.env.OPENID_REUSE_TOKENS = 'true';
    process.env.OPENID_CLIENT_ID = 'audittrace-librechat';
    store = sessionStore();
    store.records['sess-A'] = {
      openidTokens: {
        userId: 'user-1',
        accessToken: makeToken(nowS() + LIFETIME_S),
        refreshToken: 'rt-0',
        lastRefreshedAt: clock.ms,
      },
    };
  });
  afterEach(() => {
    nowSpy.mockRestore();
    process.env = { ...envBefore };
  });
  const newRequest = () =>
    store.attach(
      { headers: {}, _mockUser: { id: 'user-1', openidId: SUB }, session: undefined },
      'sess-A',
    );

  it('R28 — after a failed grant the lock is free: the next caller acquires it and a grant happens', async () => {
    let calls = 0;
    openIdClient.refreshTokenGrant.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed'); // transport error -> sovereign_refresh_failed
      return {
        access_token: makeToken(nowS() + LIFETIME_S),
        refresh_token: 'rt-1',
        expires_in: LIFETIME_S,
        token_type: 'Bearer',
        claims: () => ({ sub: SUB }),
      };
    });
    const req1 = newRequest();
    let first;
    await withAuthenticatedRequest(req1, async () => {
      clock.ms = T0_MS + (LIFETIME_S + 10) * 1000;
      first = await Promise.resolve()
        .then(() => getRequestAccessToken())
        .then(
          () => null,
          (e) => e,
        );
    });
    expect(first && first.code).toBe('sovereign_refresh_failed');
    // Structural liveness (no wall-clock bound): the lock table holds no entry for the session after the failed grant.
    expect(isLocked('sess-A')).toBe(false);
    const req2 = newRequest();
    let second;
    await withAuthenticatedRequest(req2, async () => {
      second = await getRequestAccessToken();
    });
    expect(openIdClient.refreshTokenGrant).toHaveBeenCalledTimes(2);
    expect(expOf(second)).toBeGreaterThan(nowS() + BUFFER_S);
    expect(isLocked('sess-A')).toBe(false);
  });

  it('R29 — a mid-turn refresh answering with ANOTHER subject is `sovereign_refresh_failed` (502, identity_mismatch); the session keeps its own tokens', async () => {
    openIdClient.refreshTokenGrant.mockResolvedValue({
      access_token: makeToken(nowS() + 2 * LIFETIME_S, 'kc-sub-SOMEONE-ELSE'),
      refresh_token: 'rt-evil',
      expires_in: LIFETIME_S,
      token_type: 'Bearer',
      claims: () => undefined,
    });
    const req = newRequest();
    const before = store.records['sess-A'].openidTokens.accessToken;
    let failure;
    await withAuthenticatedRequest(req, async () => {
      clock.ms = T0_MS + (LIFETIME_S + 10) * 1000;
      failure = await Promise.resolve()
        .then(() => getRequestAccessToken())
        .then(
          () => null,
          (e) => e,
        );
    });
    expect(failure).toBeInstanceOf(Error);
    expect(failure.code).toBe('sovereign_refresh_failed');
    expect(failure.status).toBe(502);
    expect(String(failure.detail || failure.message)).toMatch(/identity_mismatch/);
    expect(store.records['sess-A'].openidTokens.accessToken).toBe(before);
    expect(store.records['sess-A'].openidTokens.refreshToken).toBe('rt-0');
  });
});
