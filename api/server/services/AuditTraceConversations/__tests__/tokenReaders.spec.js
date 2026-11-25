/**
 * CONSOLE-LONG-TURN-TOKEN-REFRESH ADDENDUM-1 — B1: every reader of the user's token is served by the source.
 *
 *  R21 — SUPERSEDED by `tokenReaders.pin.spec.js` (R21 v2, ADDENDUM-2 A1): the dotted-only pin is not ported twice.
 *  R22 — the agent memory TOOL path (handleTools.js:463 → agentMethods.js:157/118) writes after an expiry
 *        with a fresh token (the live prompt was "image + memory tools").
 *  R23 — the adapter base's `requireToken()`/`currentToken()` (AuditTraceSovereignAdapter/index.js:279-296,
 *        used synchronously at Files:430, ConversationTags:488/567, ToolFavorites:343/383 and 6 base sites)
 *        resolves to a fresh STRING after an expiry, never a stale one and never a Promise handed onward.
 */
jest.mock('passport', () => ({
  _strategy: jest.fn(() => ({})),
  authenticate: jest.fn((strategy, _options, callback) => (req) => {
    return callback(null, req._mockUser ?? false, undefined, req._mockUser ? undefined : 401);
  }),
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
jest.mock('~/strategies', () => ({
  getOpenIdConfig: jest.fn(() => ({
    clientId: 'audittrace-librechat',
    serverMetadata: () => ({ jwks_uri: 'https://issuer.example.test/jwks' }),
  })),
  getOpenIdEmail: jest.fn(),
}));
jest.mock('~/server/services/AuthService', () => ({
  storeOpenIDSession: jest.fn(async () => undefined),
  setOpenIDAuthTokens: jest.fn(),
  setCloudFrontAuthCookies: jest.fn(),
}));
jest.mock('axios', () => ({ request: jest.fn() }));

const axios = require('axios');
const jwt = require('jsonwebtoken');
const openIdClient = require('openid-client');
const requireJwtAuth = require('~/server/middleware/requireJwtAuth');
const { resolveMemoryWriteMethods } = require('~/server/services/AuditTraceMemory/agentMethods');
const { AuditTraceSovereignAdapter } = require('~/server/services/AuditTraceSovereignAdapter');

const LIVE_401_DETAIL =
  'Your sign-in is no longer valid: the access token is invalid or expired. Sign out and sign in again.';
const LIFETIME_S = 300;
const BUFFER_S = 30;
const T0_MS = Date.UTC(2026, 10, 25, 13, 41, 55);
const SUB = 'kc-sub-0001';
const clock = { ms: T0_MS };
const nowS = () => Math.floor(clock.ms / 1000);
const makeToken = (expS) =>
  jwt.sign({ sub: SUB, exp: expS, iat: nowS() }, 'unit-only-secret', { noTimestamp: true });
const expOf = (token) => jwt.decode(token).exp;

function keycloakDouble() {
  const state = { current: 'rt-0', n: 0 };
  openIdClient.refreshTokenGrant.mockImplementation(async (_config, refreshToken) => {
    if (refreshToken !== state.current) {
      throw Object.assign(new Error('invalid_grant'), {
        error: 'invalid_grant',
        error_description: 'Invalid refresh token',
        status: 400,
      });
    }
    state.n += 1;
    state.current = `rt-${state.n}`;
    return {
      access_token: makeToken(nowS() + LIFETIME_S),
      refresh_token: state.current,
      expires_in: LIFETIME_S,
      token_type: 'Bearer',
      claims: () => ({ sub: SUB }),
    };
  });
  return state;
}
function bffDouble() {
  const seen = [];
  axios.request.mockImplementation(async ({ headers }) => {
    const token = String(headers.Authorization).replace(/^Bearer\s+/, '');
    seen.push(token);
    if (expOf(token) <= nowS()) {
      return { status: 401, statusText: 'Unauthorized', data: { detail: LIVE_401_DETAIL } };
    }
    return { status: 200, statusText: 'OK', data: { tier: 'private', items: [], ok: true } };
  });
  return seen;
}
function sessionOf(tokens) {
  return {
    id: 'sess-A',
    openidTokens: tokens,
    save: jest.fn((cb) => (typeof cb === 'function' ? cb() : Promise.resolve())),
    reload: jest.fn((cb) => (typeof cb === 'function' ? cb() : Promise.resolve())),
  };
}
function newRequest() {
  return {
    headers: {},
    sessionID: 'sess-A',
    _mockUser: { id: 'user-1', openidId: SUB },
    session: sessionOf({
      accessToken: makeToken(nowS() + LIFETIME_S),
      refreshToken: 'rt-0',
      lastRefreshedAt: clock.ms,
    }),
  };
}
function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}
function withAuthenticatedRequest(req, body) {
  return new Promise((resolve, reject) => {
    requireJwtAuth(req, mockRes(), () => Promise.resolve().then(body).then(resolve, reject));
  });
}

describe('CONSOLE-LONG-TURN-TOKEN-REFRESH ADDENDUM-1 — every token reader is served by the source', () => {
  let nowSpy;
  const envBefore = { ...process.env };
  beforeEach(() => {
    jest.clearAllMocks();
    clock.ms = T0_MS;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => clock.ms);
    process.env.AUDITTRACE_MEMORY_BACKEND = 'sovereign';
    process.env.AUDITTRACE_BFF_BASE_URL = 'http://bff.test:8766';
    process.env.OPENID_REUSE_TOKENS = 'true';
  });
  afterEach(() => {
    nowSpy.mockRestore();
    process.env = { ...envBefore };
  });

  it('R22 — an agent memory-tool write after an expiry reaches the BFF with a fresh token (handleTools → agentMethods)', async () => {
    keycloakDouble();
    const seen = bffDouble();
    const req = newRequest();
    let outcome;
    await withAuthenticatedRequest(req, async () => {
      const methods = resolveMemoryWriteMethods({
        req,
        mongoMethods: {
          setMemory: jest.fn(),
          deleteMemory: jest.fn(),
          getFormattedMemories: jest.fn(),
        },
      });
      clock.ms = T0_MS + (LIFETIME_S + 10) * 1000; // the tool fires after the first expiry
      outcome = await methods
        .deleteMemory({ userId: 'user-1', key: 'procedural:unit-skill.md' })
        .then(
          () => 'ok',
          (e) => e,
        );
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const token of seen) expect(expOf(token)).toBeGreaterThan(nowS());
    expect(outcome && outcome.status).not.toBe(401);
    expect(openIdClient.refreshTokenGrant).toHaveBeenCalledTimes(1);
  });

  it('R23 — the adapter base requireToken()/currentToken() yield a fresh STRING after an expiry (never stale, never a Promise)', async () => {
    keycloakDouble();
    const req = newRequest();
    const adapter = new AuditTraceSovereignAdapter({
      domain: 'unit',
      callProxy: jest.fn(),
      idField: 'id',
      ownerField: 'user_sub',
      fromApi: (x) => x,
      toApiBody: (_id, x) => x,
      methods: { getUnit: { kind: 'read', arity: 1, impl: async () => null } },
    });
    let viaRequire, viaCurrent;
    await withAuthenticatedRequest(req, async () => {
      clock.ms = T0_MS + (LIFETIME_S + 10) * 1000;
      viaRequire = await adapter.requireToken(undefined);
      viaCurrent = await adapter.currentToken();
    });
    expect(typeof viaRequire).toBe('string');
    expect(expOf(viaRequire)).toBeGreaterThan(nowS() + BUFFER_S);
    expect(typeof viaCurrent).toBe('string');
    expect(expOf(viaCurrent)).toBeGreaterThan(nowS() + BUFFER_S);
  });
});
