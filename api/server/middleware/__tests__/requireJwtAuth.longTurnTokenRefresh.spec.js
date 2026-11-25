/**
 * CONSOLE-LONG-TURN-TOKEN-REFRESH ADDENDUM-1 — RED tests v2 (fork @ a6deb17e).
 * Supersedes `…RED.requireJwtAuth.longTurnTokenRefresh.spec.js` (same destination file):
 *   - S1 (operator ruling "Expired vs ended"): R3a now expects `sovereign_session_expired`;
 *     R4 is early termination (administrator sign-out / logout elsewhere), not idle/max.
 *   - B3: R10 (2 concurrent calls, 1 request → 1 grant), R11 (2 concurrent requests of one
 *     session → 1 grant; the second re-reads the stored token), R12 (reload before, save after),
 *     R13 (exp − 31 s → no grant; exp − 29 s → grant), R14 (refreshController and the source
 *     share the process-wide lock keyed on req.sessionID → 1 grant).
 *   - S1/A3/A4: R15 (`sovereign_refresh_failed`: transport error and 5xx → 502), R16 (a refresh
 *     token that is not a JWT or has no `exp` falls through to Keycloak), R17 (a failed
 *     `req.session.reload()` → `sovereign_session_expired`).
 * Contract pinned: the source holds `req` (not `req.session`); `req.session.reload()` runs
 * before a grant and `req.session.save()` after it; one process-wide lock keyed on
 * `req.sessionID`, shared with `refreshController`; `openid-client.refreshTokenGrant(
 * getOpenIdConfig(), <newest RT>, buildOpenIDRefreshParams())`; the local `exp` check of
 * the refresh token decides `sovereign_session_expired` without calling Keycloak.
 * Clock: `Date.now` stub. BFF double: 401 with the live text for `exp <= now`.
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
    serverMetadata: () => ({
      jwks_uri: 'https://issuer.example.test/jwks',
      issuer: 'https://issuer.example.test/realms/audittrace',
    }),
  })),
  getOpenIdEmail: jest.fn(() => 'user@example.test'),
}));
jest.mock('~/server/services/AuthService', () => ({
  storeOpenIDSession: jest.fn(async () => undefined),
  setOpenIDAuthTokens: jest.fn(() => 'app-token'),
  setCloudFrontAuthCookies: jest.fn(),
  requestPasswordReset: jest.fn(),
  resetPassword: jest.fn(),
  setAuthTokens: jest.fn(),
  registerUser: jest.fn(),
}));
jest.mock('~/server/services/GraphTokenService', () => ({ getGraphApiToken: jest.fn() }));
jest.mock('~/models', () => ({
  deleteAllUserSessions: jest.fn(),
  getUserById: jest.fn(async () => ({
    _id: { toString: () => 'user-1' },
    id: 'user-1',
    email: 'u@example.test',
    openidId: 'kc-sub-0001',
  })),
  findSession: jest.fn(),
  updateUser: jest.fn(),
  findUser: jest.fn(),
}));
jest.mock('axios', () => ({ request: jest.fn() }));

const axios = require('axios');
const jwt = require('jsonwebtoken');
const openIdClient = require('openid-client');
const { logger } = require('@librechat/data-schemas');
const { storeOpenIDSession } = require('~/server/services/AuthService');
const requireJwtAuth = require('../requireJwtAuth');
const { getRequestAccessToken } = require('../../services/AuditTraceConversations/requestContext');
const { wrapModelMethods } = require('../../services/AuditTraceConversations');
const { refreshController } = require('../../controllers/AuthController');

const LIVE_401_DETAIL =
  'Your sign-in is no longer valid: the access token is invalid or expired. Sign out and sign in again.';
const LIFETIME_S = 300;
const REFRESH_LIFETIME_S = 28800;
const BUFFER_S = 30;
const T0_MS = Date.UTC(2026, 10, 25, 13, 41, 55);
const SUB = 'kc-sub-0001';
const CONVERSATION_ID = 'fa78a7d3-a137-5349-9b8c-6557e707f810';
const MESSAGE_ID = '2baf6962-cc69-41de-a045-df5a14a00f92';

const clock = { ms: T0_MS };
const nowS = () => Math.floor(clock.ms / 1000);
const makeToken = (expS, extra = {}) =>
  jwt.sign({ sub: SUB, exp: expS, iat: nowS(), ...extra }, 'unit-only-secret', {
    noTimestamp: true,
  });
const expOf = (token) => jwt.decode(token).exp;
const invalidGrant = (description) =>
  Object.assign(new Error('invalid_grant'), {
    error: 'invalid_grant',
    error_description: description,
    status: 400,
  });

/** Keycloak double: rotation + reuse detection; optional scripted refusals; counts in-flight grants. */
function keycloakDouble({
  sessionEnded = false,
  revoke = false,
  transportError = false,
  http5xx = false,
  grantDelayMs = 0,
} = {}) {
  const state = { current: 'rt-0', issued: [], n: 0, inFlight: 0, maxInFlight: 0 };
  openIdClient.refreshTokenGrant.mockImplementation(async (_config, refreshToken) => {
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    try {
      if (grantDelayMs) {
        await new Promise((r) => setTimeout(r, grantDelayMs));
      }
      if (transportError) {
        throw new TypeError('fetch failed');
      }
      if (http5xx) {
        throw Object.assign(new Error('temporarily_unavailable'), {
          error: 'temporarily_unavailable',
          status: 503,
        });
      }
      if (sessionEnded) {
        throw invalidGrant('Session not active');
      }
      if (revoke || refreshToken !== state.current) {
        throw invalidGrant('Invalid refresh token');
      }
      state.n += 1;
      state.current = `rt-${state.n}`;
      const access_token = makeToken(nowS() + LIFETIME_S);
      state.issued.push(access_token);
      return {
        access_token,
        refresh_token: state.current,
        expires_in: LIFETIME_S,
        token_type: 'Bearer',
        claims: () => ({ sub: SUB, iss: 'https://issuer.example.test/realms/audittrace' }),
      };
    } finally {
      state.inFlight -= 1;
    }
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
    return {
      status: 200,
      statusText: 'OK',
      data: {
        message_id: MESSAGE_ID,
        conversation_id: CONVERSATION_ID,
        parent_message_id: null,
        sender: 'AI',
        text: 'full answer',
        is_created_by_user: false,
        metadata: {},
        created_at_ms: clock.ms,
        updated_at_ms: clock.ms,
      },
    };
  });
  return seen;
}

/**
 * An in-process session store double with express-session 1.18.2 semantics: `reload()` re-reads the
 * record and REPLACES `req.session` (store.createSession, store.js:100); `save()` writes the record.
 * Every request of the same sessionID shares `store.records[sessionID]`.
 */
function sessionStore() {
  const store = { records: {}, events: [] };
  store.attach = (req, sessionID) => {
    const make = () => {
      const data = store.records[sessionID];
      const session = {
        id: sessionID,
        openidTokens: data ? JSON.parse(JSON.stringify(data.openidTokens)) : undefined,
        save: jest.fn((cb) => {
          store.records[sessionID] = {
            openidTokens: JSON.parse(JSON.stringify(req.session.openidTokens)),
          };
          store.events.push(['save', sessionID]);
          if (typeof cb === 'function') cb();
          return Promise.resolve();
        }),
        reload: jest.fn((cb) => {
          store.events.push(['reload', sessionID]);
          if (store.failReload) {
            const err = new Error('session gone from the store');
            if (typeof cb === 'function') cb(err);
            return Promise.reject(err);
          }
          req.session = make(); // express-session replaces req.session on reload
          if (typeof cb === 'function') cb();
          return Promise.resolve();
        }),
      };
      return session;
    };
    req.sessionID = sessionID;
    req.session = make();
    return req;
  };
  store.seed = (sessionID, openidTokens) => {
    store.records[sessionID] = { openidTokens };
  };
  return store;
}

function freshSessionTokens(accessExpS, refreshToken = 'rt-0') {
  return {
    accessToken: makeToken(accessExpS),
    idToken: undefined,
    refreshToken,
    expiresAt: clock.ms + 30 * 24 * 3600 * 1000,
    lastRefreshedAt: clock.ms,
  };
}

function mockRes() {
  const res = {};
  for (const k of ['status', 'send', 'json', 'redirect', 'cookie']) res[k] = jest.fn(() => res);
  return res;
}

function withAuthenticatedRequest(req, body) {
  return new Promise((resolve, reject) => {
    requireJwtAuth(req, mockRes(), () => {
      Promise.resolve().then(body).then(resolve, reject);
    });
  });
}

const allLogText = () =>
  ['debug', 'info', 'warn', 'error']
    .flatMap((level) => logger[level].mock.calls)
    .map((args) => JSON.stringify(args, (_k, v) => (v instanceof Error ? v.message : v)))
    .join('\n');

describe('CONSOLE-LONG-TURN-TOKEN-REFRESH v2 — the request token stays fresh for the whole turn', () => {
  let nowSpy;
  let store;
  const envBefore = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    clock.ms = T0_MS;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => clock.ms);
    process.env.AUDITTRACE_MEMORY_BACKEND = 'sovereign';
    process.env.AUDITTRACE_BFF_BASE_URL = 'http://bff.test:8766';
    process.env.OPENID_REUSE_TOKENS = 'true';
    process.env.JWT_REFRESH_SECRET = 'unit-only-refresh-secret';
    store = sessionStore();
  });
  afterEach(() => {
    nowSpy.mockRestore();
    process.env = { ...envBefore };
  });

  const newRequest = (sessionID = 'sess-A', tokens = freshSessionTokens(nowS() + LIFETIME_S)) => {
    if (!store.records[sessionID]) store.seed(sessionID, tokens);
    return store.attach({ headers: {}, _mockUser: { id: 'user-1', openidId: SUB } }, sessionID);
  };
  const failureOf = (p) =>
    p.then(
      () => null,
      (e) => e,
    );

  it('R1 — a turn spanning three access-token lifetimes refreshes three times, each time with the NEWEST refresh token', async () => {
    const kc = keycloakDouble();
    const req = newRequest();
    await withAuthenticatedRequest(req, async () => {
      for (const k of [1, 2, 3]) {
        clock.ms = T0_MS + (k * LIFETIME_S + 10) * 1000;
        const token = await getRequestAccessToken();
        expect(typeof token).toBe('string');
        expect(expOf(token)).toBeGreaterThan(nowS() + BUFFER_S);
      }
    });
    expect(openIdClient.refreshTokenGrant).toHaveBeenCalledTimes(3);
    expect(openIdClient.refreshTokenGrant.mock.calls.map((c) => c[1])).toEqual([
      'rt-0',
      'rt-1',
      'rt-2',
    ]);
    expect(store.records['sess-A'].openidTokens.refreshToken).toBe('rt-3');
    expect(storeOpenIDSession).toHaveBeenCalled();
    expect(kc.issued).toHaveLength(3);
  });

  it('R2 — the terminal save of a 738 s turn reaches the BFF with an unexpired token (the live 401 does not recur)', async () => {
    keycloakDouble();
    const seen = bffDouble();
    const req = newRequest();
    const wrapped = wrapModelMethods({ saveMessage: jest.fn(async () => ({ mongo: true })) });
    await withAuthenticatedRequest(req, async () => {
      clock.ms = T0_MS + 738 * 1000;
      const saved = await wrapped.saveMessage(
        { userId: 'user-1' },
        {
          conversationId: CONVERSATION_ID,
          messageId: MESSAGE_ID,
          text: 'full answer',
          user: 'user-1',
        },
      );
      expect(saved).toBeTruthy();
    });
    expect(seen).toHaveLength(1);
    expect(expOf(seen[0])).toBeGreaterThan(nowS());
    expect(openIdClient.refreshTokenGrant).toHaveBeenCalledTimes(1);
  });

  it('R3a — hard limit, the refresh token reached its time limit: `sovereign_session_expired`, decided locally, Keycloak not called', async () => {
    keycloakDouble();
    const seen = bffDouble();
    const refreshToken = makeToken(nowS() + REFRESH_LIFETIME_S, { typ: 'Refresh' });
    const req = newRequest('sess-A', freshSessionTokens(nowS() + LIFETIME_S, refreshToken));
    const wrapped = wrapModelMethods({ saveMessage: jest.fn() });
    let failure;
    await withAuthenticatedRequest(req, async () => {
      clock.ms = T0_MS + (REFRESH_LIFETIME_S + 5) * 1000;
      failure = await failureOf(
        wrapped.saveMessage(
          { userId: 'user-1' },
          { conversationId: CONVERSATION_ID, messageId: MESSAGE_ID },
        ),
      );
    });
    expect(failure).toBeInstanceOf(Error);
    expect(failure.code).toBe('sovereign_session_expired');
    expect(failure.status).toBe(401);
    expect(failure.message).not.toContain(refreshToken);
    expect(openIdClient.refreshTokenGrant).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
  });

  it('R3b — hard limit, Keycloak refuses the refresh token (revoked / rotated away): `sovereign_refresh_token_rejected`', async () => {
    keycloakDouble({ revoke: true });
    bffDouble();
    const req = newRequest();
    const wrapped = wrapModelMethods({ saveMessage: jest.fn() });
    let failure;
    await withAuthenticatedRequest(req, async () => {
      clock.ms = T0_MS + (LIFETIME_S + 10) * 1000;
      failure = await failureOf(
        wrapped.saveMessage(
          { userId: 'user-1' },
          { conversationId: CONVERSATION_ID, messageId: MESSAGE_ID },
        ),
      );
    });
    expect(failure.code).toBe('sovereign_refresh_token_rejected');
    expect(failure.status).toBe(401);
    expect(openIdClient.refreshTokenGrant).toHaveBeenCalledTimes(1);
  });

  it('R4 — hard limit, Keycloak ended the session EARLY (administrator sign-out, logout elsewhere): `sovereign_sso_session_ended`', async () => {
    keycloakDouble({ sessionEnded: true });
    bffDouble();
    const req = newRequest();
    const wrapped = wrapModelMethods({ saveMessage: jest.fn() });
    let failure;
    await withAuthenticatedRequest(req, async () => {
      clock.ms = T0_MS + (LIFETIME_S + 10) * 1000;
      failure = await failureOf(
        wrapped.saveMessage(
          { userId: 'user-1' },
          { conversationId: CONVERSATION_ID, messageId: MESSAGE_ID },
        ),
      );
    });
    expect(failure.code).toBe('sovereign_sso_session_ended');
    expect(failure.status).toBe(401);
    expect(openIdClient.refreshTokenGrant).toHaveBeenCalledTimes(1);
  });

  it('R5 — a refresh happened and no access or refresh token string reached any log line', async () => {
    const kc = keycloakDouble();
    const req = newRequest();
    const initial = req.session.openidTokens.accessToken;
    await withAuthenticatedRequest(req, async () => {
      clock.ms = T0_MS + (LIFETIME_S + 10) * 1000;
      await getRequestAccessToken();
    });
    expect(openIdClient.refreshTokenGrant).toHaveBeenCalledTimes(1);
    const logs = allLogText();
    for (const secret of [initial, ...kc.issued, 'rt-0', 'rt-1'])
      expect(logs).not.toContain(secret);
  });

  it('R10 — two concurrent calls in ONE request make exactly one grant and get the same fresh token', async () => {
    const kc = keycloakDouble({ grantDelayMs: 5 });
    const req = newRequest();
    let a, b;
    await withAuthenticatedRequest(req, async () => {
      clock.ms = T0_MS + (LIFETIME_S + 10) * 1000;
      [a, b] = await Promise.all([getRequestAccessToken(), getRequestAccessToken()]);
    });
    expect(openIdClient.refreshTokenGrant).toHaveBeenCalledTimes(1);
    expect(kc.maxInFlight).toBe(1);
    expect(a).toBe(b);
    expect(expOf(a)).toBeGreaterThan(nowS() + BUFFER_S);
  });

  it('R11 — two concurrent requests of the SAME session make exactly one grant; the second re-reads the stored token', async () => {
    const kc = keycloakDouble({ grantDelayMs: 5 });
    const req1 = newRequest('sess-A');
    const req2 = newRequest('sess-A');
    let a, b;
    clock.ms = T0_MS + (LIFETIME_S + 10) * 1000;
    await Promise.all([
      withAuthenticatedRequest(req1, async () => {
        a = await getRequestAccessToken();
      }),
      withAuthenticatedRequest(req2, async () => {
        b = await getRequestAccessToken();
      }),
    ]);
    expect(openIdClient.refreshTokenGrant).toHaveBeenCalledTimes(1);
    expect(kc.maxInFlight).toBe(1);
    expect(a).toBe(b);
    expect(store.records['sess-A'].openidTokens.accessToken).toBe(a);
  });

  it('R12 — the session is reloaded BEFORE the grant and saved AFTER it, with the new tokens in the saved record', async () => {
    keycloakDouble();
    const grant = openIdClient.refreshTokenGrant.getMockImplementation();
    openIdClient.refreshTokenGrant.mockImplementation(async (...args) => {
      store.events.push(['grant', 'sess-A']);
      return grant(...args);
    });
    const req = newRequest();
    await withAuthenticatedRequest(req, async () => {
      clock.ms = T0_MS + (LIFETIME_S + 10) * 1000;
      await getRequestAccessToken();
    });
    const order = store.events.map((e) => e[0]);
    expect(order).toEqual(expect.arrayContaining(['reload', 'grant', 'save']));
    expect(order.indexOf('reload')).toBeLessThan(order.indexOf('grant'));
    expect(order.indexOf('grant')).toBeLessThan(order.indexOf('save'));
    expect(store.records['sess-A'].openidTokens.refreshToken).toBe('rt-1');
  });

  it('R13 — refresh only when needed: at exp − 31 s no grant; at exp − 29 s one grant', async () => {
    keycloakDouble();
    const req = newRequest();
    let early, late;
    await withAuthenticatedRequest(req, async () => {
      clock.ms = T0_MS + (LIFETIME_S - 31) * 1000;
      early = await getRequestAccessToken();
      expect(openIdClient.refreshTokenGrant).toHaveBeenCalledTimes(0);
      expect(early).toBe(store.records['sess-A'].openidTokens.accessToken);
      clock.ms = T0_MS + (LIFETIME_S - 29) * 1000;
      late = await getRequestAccessToken();
    });
    expect(openIdClient.refreshTokenGrant).toHaveBeenCalledTimes(1);
    expect(expOf(late)).toBeGreaterThan(nowS() + BUFFER_S);
  });

  it("R14 — the browser's refreshController and a mid-turn refresh of the same session share the lock: one grant, both fresh", async () => {
    const kc = keycloakDouble({ grantDelayMs: 5 });
    const req1 = newRequest('sess-A');
    const req2 = newRequest('sess-A');
    req2.headers = { cookie: 'token_provider=openid; refreshToken=rt-0' };
    const res2 = mockRes();
    let fromSource;
    clock.ms = T0_MS + (LIFETIME_S + 10) * 1000;
    await Promise.all([
      withAuthenticatedRequest(req1, async () => {
        fromSource = await getRequestAccessToken();
      }),
      refreshController(req2, res2),
    ]);
    expect(openIdClient.refreshTokenGrant).toHaveBeenCalledTimes(1);
    expect(kc.maxInFlight).toBe(1);
    expect(expOf(fromSource)).toBeGreaterThan(nowS() + BUFFER_S);
    expect(res2.status).toHaveBeenCalledWith(200);
    expect(res2.status).not.toHaveBeenCalledWith(403);
  });

  it('R15 — `sovereign_refresh_failed` (502) for a transport error and for a 5xx from the token endpoint', async () => {
    for (const opts of [{ transportError: true }, { http5xx: true }]) {
      jest.clearAllMocks();
      clock.ms = T0_MS; // each pass starts a fresh turn (the previous pass left the clock past T0)
      store = sessionStore();
      keycloakDouble(opts);
      bffDouble();
      const req = newRequest();
      const wrapped = wrapModelMethods({ saveMessage: jest.fn() });
      let failure;
      await withAuthenticatedRequest(req, async () => {
        clock.ms = T0_MS + (LIFETIME_S + 10) * 1000;
        failure = await failureOf(
          wrapped.saveMessage(
            { userId: 'user-1' },
            { conversationId: CONVERSATION_ID, messageId: MESSAGE_ID },
          ),
        );
      });
      expect(failure.code).toBe('sovereign_refresh_failed');
      expect(failure.status).toBe(502);
    }
  });

  it('R16 — a refresh token that is not a JWT (or has no exp) is NOT judged locally: Keycloak is asked and the refresh succeeds', async () => {
    keycloakDouble();
    const req = newRequest('sess-A', freshSessionTokens(nowS() + LIFETIME_S, 'rt-0'));
    // 'rt-0' is opaque: jwt.decode('rt-0') === null
    let token;
    await withAuthenticatedRequest(req, async () => {
      clock.ms = T0_MS + (LIFETIME_S + 10) * 1000;
      token = await getRequestAccessToken();
    });
    expect(openIdClient.refreshTokenGrant).toHaveBeenCalledTimes(1);
    expect(expOf(token)).toBeGreaterThan(nowS() + BUFFER_S);
  });

  it('R17 — a failed req.session.reload() (the Express session is gone from the store) is `sovereign_session_expired`, Keycloak not called', async () => {
    keycloakDouble();
    bffDouble();
    const req = newRequest();
    store.failReload = true;
    const wrapped = wrapModelMethods({ saveMessage: jest.fn() });
    let failure;
    await withAuthenticatedRequest(req, async () => {
      clock.ms = T0_MS + (LIFETIME_S + 10) * 1000;
      failure = await failureOf(
        wrapped.saveMessage(
          { userId: 'user-1' },
          { conversationId: CONVERSATION_ID, messageId: MESSAGE_ID },
        ),
      );
    });
    expect(failure.code).toBe('sovereign_session_expired');
    expect(failure.status).toBe(401);
    expect(openIdClient.refreshTokenGrant).not.toHaveBeenCalled();
  });
});
