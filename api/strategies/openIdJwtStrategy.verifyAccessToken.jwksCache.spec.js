/**
 * A5 (review r1): `verifyOpenIdAccessToken` keeps ONE real `jwks-rsa` client per `jwksUri`, so the
 * client's key cache hits: two verifications make ONE JWKS fetch. A local HTTP server serves the
 * realm key and counts the requests (no mock of jwks-rsa, no wall clock).
 * Neuter: build a client per call -> two fetches -> RED.
 */
const http = require('http');
jest.mock('passport-jwt', () => ({
  Strategy: jest.fn(() => ({ name: 'jwt' })),
  ExtractJwt: { fromAuthHeaderAsBearerToken: jest.fn(() => 'mock-extractor') },
}));
jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
  getTenantId: jest.fn(),
  runAsSystem: jest.fn((fn) => fn()),
}));
jest.mock('@librechat/api', () => ({
  isEnabled: jest.fn(() => false),
  findOpenIDUser: jest.fn(),
  getOpenIdEmail: jest.fn(),
  getOpenIdIssuer: jest.fn(),
  normalizeOpenIdIssuer: jest.requireActual('@librechat/api').normalizeOpenIdIssuer,
  buildAuthUserDocCacheKey: jest.fn(),
  getAuthUserDocCacheMode: jest.fn(() => 'off'),
  getCachedAuthUserDoc: jest.fn(),
  getValidOpenIdReuseUserId: jest.fn(),
  invalidateCachedAuthUserDoc: jest.fn(),
  setCachedAuthUserDoc: jest.fn(),
  getHttpsProxyAgent: jest.fn(() => undefined),
  isAccessTokenJwt: jest.fn(),
  math: jest.fn((val, fallback) => fallback),
}));
jest.mock('~/models', () => ({
  findUser: jest.fn(),
  updateUser: jest.fn(),
  isAgentTriggerPrincipalActive: jest.fn(() => true),
}));
jest.mock('~/server/services/Files/strategies', () => ({ getStrategyFunctions: jest.fn() }));
jest.mock('~/server/services/Config', () => ({ getAppConfig: jest.fn().mockResolvedValue({}) }));
jest.mock('~/cache/getLogStores', () => jest.fn(() => ({ get: jest.fn(), set: jest.fn() })));

const { generateKeyPairSync } = require('crypto');
const jwt = require('jsonwebtoken');
const openIdJwtLogin = require('./openIdJwtStrategy');

const ISSUER = 'https://issuer.example.test/realms/audittrace';
const CLIENT = 'audittrace-librechat';
const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const sign = () =>
  jwt.sign(
    { sub: 'kc-sub-A', iss: ISSUER, azp: CLIENT, typ: 'Bearer' },
    key.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { algorithm: 'RS256', keyid: 'kid-A', expiresIn: 300 },
  );

describe('verifyOpenIdAccessToken — JWKS client cache (A5)', () => {
  let server;
  let fetches;
  let openIdConfig;
  const envBefore = { ...process.env };

  beforeAll(async () => {
    fetches = 0;
    const jwk = {
      ...key.publicKey.export({ format: 'jwk' }),
      kid: 'kid-A',
      use: 'sig',
      alg: 'RS256',
    };
    server = http.createServer((req, res) => {
      fetches += 1;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    openIdConfig = {
      serverMetadata: () => ({
        jwks_uri: `http://127.0.0.1:${server.address().port}/jwks`,
        issuer: ISSUER,
      }),
    };
  });
  afterAll(async () => {
    process.env = { ...envBefore };
    await new Promise((resolve) => server.close(resolve));
  });

  it('two verifications cause one JWKS fetch', async () => {
    process.env.OPENID_CLIENT_ID = CLIENT;
    openIdJwtLogin.resetJwksClients();
    fetches = 0;
    const first = await openIdJwtLogin.verifyOpenIdAccessToken(sign(), openIdConfig);
    const second = await openIdJwtLogin.verifyOpenIdAccessToken(sign(), openIdConfig);
    expect(first.sub).toBe('kc-sub-A');
    expect(second.sub).toBe('kc-sub-A');
    expect(fetches).toBe(1);
  });
});
