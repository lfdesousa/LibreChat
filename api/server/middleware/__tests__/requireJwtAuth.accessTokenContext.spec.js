/**
 * MongoDB-elimination WU-2b — proves `requireJwtAuth` populates the
 * chokepoint's request-access-token `AsyncLocalStorage`
 * (`AuditTraceConversations/requestContext`) from
 * `req.session.openidTokens.accessToken` + `req.user.id`, alongside the
 * pre-existing tenant-context chaining `requireJwtAuth.spec.js` covers.
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
  isEnabled: jest.fn(() => false),
  recordRumProxyRequest: jest.fn(),
  getAuthFailureReasonCategory: jest.fn(() => 'missing_or_unrecognized_token'),
  buildSafeAuthLogContext: jest.fn(() => ({})),
  getValidOpenIdReuseUserId: jest.fn(() => null),
  maybeRefreshCloudFrontAuthCookiesMiddleware: (req, res, next) => next(),
  // Minimal stand-in: just calls next() directly (this file's concern is
  // the access-token context, not tenant-context chaining — that is
  // `requireJwtAuth.spec.js`'s job).
  tenantContextMiddleware: (req, res, next) => next(),
}));

const requireJwtAuth = require('../requireJwtAuth');
const {
  getRequestAccessToken,
  getRequestSub,
} = require('../../services/AuditTraceConversations/requestContext');

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}

describe('requireJwtAuth — access-token context propagation (MongoDB-elimination WU-2b)', () => {
  it('populates the request-access-token context from req.session.openidTokens.accessToken + req.user.id', async () => {
    const req = {
      headers: {},
      _mockUser: { id: 'user-1', tenantId: 'tenant-1' },
      session: { openidTokens: { accessToken: 'the-oidc-access-token' } },
    };
    const res = mockRes();
    let observed;

    await new Promise((resolve) => {
      requireJwtAuth(req, res, () => {
        observed = { token: getRequestAccessToken(), sub: getRequestSub() };
        resolve();
      });
    });

    expect(observed).toEqual({ token: 'the-oidc-access-token', sub: 'user-1' });
  });

  it('a request with no OIDC console session has no access-token context (falls through to Mongo at the chokepoint)', async () => {
    const req = { headers: {}, _mockUser: { id: 'user-2', tenantId: 'tenant-1' } };
    const res = mockRes();
    let observed;

    await new Promise((resolve) => {
      requireJwtAuth(req, res, () => {
        observed = getRequestAccessToken();
        resolve();
      });
    });

    expect(observed).toBeUndefined();
  });

  it('the access-token context does not leak to a request made afterwards with no session', async () => {
    const withSession = {
      headers: {},
      _mockUser: { id: 'user-3' },
      session: { openidTokens: { accessToken: 'tok-3' } },
    };
    await new Promise((resolve) => requireJwtAuth(withSession, mockRes(), resolve));

    const withoutSession = { headers: {}, _mockUser: { id: 'user-4' } };
    let observed;
    await new Promise((resolve) => {
      requireJwtAuth(withoutSession, mockRes(), () => {
        observed = getRequestAccessToken();
        resolve();
      });
    });

    expect(observed).toBeUndefined();
  });

  it('does not establish any access-token context when authentication fails', async () => {
    const req = { headers: {}, _mockUser: false };
    const res = mockRes();
    const next = jest.fn();

    requireJwtAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(getRequestAccessToken()).toBeUndefined();
  });
});
