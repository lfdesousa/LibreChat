/**
 * CONSOLE-LONG-TURN-TOKEN-REFRESH ADDENDUM-2 — S1 (gate r2): the `sub` check after a refresh is the STRATEGY's verifier.
 *
 * Contract: `api/strategies/openIdJwtStrategy.js` exports `verifyOpenIdAccessToken(token, openIdConfig)` as a property of
 * the exported `openIdJwtLogin` function (so `require('./openIdJwtStrategy')` stays a function for `~/strategies/index.js:2`)
 * and `~/strategies` re-exports it. It builds the SAME `jwksRsaOptions` the strategy builds (cache, cacheMaxAge, jwksUri from
 * `openIdConfig.serverMetadata().jwks_uri`, `requestAgent` from `getHttpsProxyAgent`; openIdJwtStrategy.js:120-131), takes
 * the signing key for the token's `kid` from `jwks-rsa` (`jwksClient(options).getSigningKey(kid).getPublicKey()`), verifies
 * with `jsonwebtoken.verify(token, key, { algorithms: ['RS256'] })`, requires `isOpenIdIssuerAllowed(payload, openIdConfig)`
 * (:67, the strategy's allow-list incl. the `{tenantid}` template) and `payload.azp === process.env.OPENID_CLIENT_ID`, and
 * returns the payload. Audience is NOT enforced on the ACCESS token (its `aud` names resource servers; whether the live token's
 * `aud` includes `audittrace-librechat` is not measured — no token reads); `azp` is the client binding for access tokens.
 * RED today: the export does not exist. Neuter "decode instead of verify" → R25b RED; "drop the issuer check" → R26 RED;
 * "drop azp" → R27 RED.
 *
 * Mocks mirror api/strategies/openIdJwtStrategy.spec.js (the shipped file), with `jwks-rsa` a callable client factory.
 */
const mockGetLogStores = jest.fn(() => ({ get: jest.fn(), set: jest.fn() }));
jest.mock('passport-jwt', () => ({
  Strategy: jest.fn(() => ({ name: 'jwt' })),
  ExtractJwt: { fromAuthHeaderAsBearerToken: jest.fn(() => 'mock-extractor') },
}));
const mockGetSigningKey = jest.fn();
jest.mock('jwks-rsa', () =>
  Object.assign(
    jest.fn(() => ({ getSigningKey: mockGetSigningKey })),
    { passportJwtSecret: jest.fn(() => 'mock-secret-provider') },
  ),
);
jest.mock('https-proxy-agent', () => ({ HttpsProxyAgent: jest.fn() }));
jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
  getTenantId: jest.fn(),
  runAsSystem: jest.fn((fn) => fn()),
}));
jest.mock('@librechat/api', () => ({
  isEnabled: jest.fn(() => false),
  findOpenIDUser: jest.fn(),
  getOpenIdEmail: jest.requireActual('@librechat/api').getOpenIdEmail,
  getOpenIdIssuer: jest.fn(() => 'https://issuer.example.test/realms/audittrace'),
  normalizeOpenIdIssuer: jest.requireActual('@librechat/api').normalizeOpenIdIssuer,
  buildAuthUserDocCacheKey: jest.fn(() => 'auth-user-doc-key'),
  getAuthUserDocCacheMode: jest.fn(() => 'off'),
  getCachedAuthUserDoc: jest.fn(),
  getValidOpenIdReuseUserId: jest.fn(),
  invalidateCachedAuthUserDoc: jest.fn(),
  setCachedAuthUserDoc: jest.fn(),
  getHttpsProxyAgent: jest.fn(() => undefined),
  isAccessTokenJwt: jest.requireActual('@librechat/api').isAccessTokenJwt,
  math: jest.fn((val, fallback) => fallback),
}));
jest.mock('~/models', () => ({
  findUser: jest.fn(),
  updateUser: jest.fn(),
  isAgentTriggerPrincipalActive: jest.fn(() => true),
}));
jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(() => ({ saveBuffer: jest.fn() })),
}));
jest.mock('~/server/services/Config', () => ({ getAppConfig: jest.fn().mockResolvedValue({}) }));
jest.mock('~/cache/getLogStores', () => mockGetLogStores);

const { generateKeyPairSync } = require('crypto');
const jwt = require('jsonwebtoken');
const jwksRsa = require('jwks-rsa');
const openIdJwtLogin = require('./openIdJwtStrategy');

const ISSUER = 'https://issuer.example.test/realms/audittrace';
const CLIENT = 'audittrace-librechat';
const keyA = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyB = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = (k, type) => k.export({ type, format: 'pem' });
const T0_S = Math.floor(Date.UTC(2026, 10, 25, 13, 41, 55) / 1000);
const sign = (key, claims) =>
  jwt.sign(
    {
      sub: 'kc-sub-A',
      iss: ISSUER,
      azp: CLIENT,
      aud: ['audittrace-server', 'account'],
      exp: T0_S + 300,
      iat: T0_S,
      typ: 'Bearer',
      ...claims,
    },
    pem(key.privateKey, 'pkcs8'),
    { algorithm: 'RS256', keyid: 'kid-A', noTimestamp: true },
  );
const openIdConfig = {
  clientId: CLIENT,
  serverMetadata: () => ({ jwks_uri: 'https://issuer.example.test/jwks', issuer: ISSUER }),
};
const envBefore = { ...process.env };

describe("CONSOLE-LONG-TURN-TOKEN-REFRESH ADDENDUM-2 — verifyOpenIdAccessToken is the strategy's verifier", () => {
  let nowSpy;
  beforeEach(() => {
    jest.clearAllMocks();
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => (T0_S + 5) * 1000);
    openIdJwtLogin.resetJwksClients();
    process.env.OPENID_CLIENT_ID = CLIENT;
    // the JWKS serves key A only (whatever kid is asked)
    mockGetSigningKey.mockImplementation(async () => ({
      getPublicKey: () => pem(keyA.publicKey, 'spki'),
    }));
  });
  afterEach(() => {
    nowSpy.mockRestore();
    process.env = { ...envBefore };
  });

  it("R25 — a token signed by the realm key, with the allowed issuer and azp = client, verifies and yields the payload (JWKS asked with the strategy's options)", async () => {
    const verify = openIdJwtLogin.verifyOpenIdAccessToken;
    expect(typeof verify).toBe('function');
    const payload = await verify(sign(keyA, {}), openIdConfig);
    expect(payload.sub).toBe('kc-sub-A');
    expect(jwksRsa).toHaveBeenCalledWith(
      expect.objectContaining({ jwksUri: 'https://issuer.example.test/jwks', cache: true }),
    );
    expect(mockGetSigningKey).toHaveBeenCalledWith('kid-A');
  });

  it('R25b — a token signed by ANOTHER key is rejected (a decode-only check would accept it)', async () => {
    const verify = openIdJwtLogin.verifyOpenIdAccessToken;
    await expect(verify(sign(keyB, {}), openIdConfig)).rejects.toBeInstanceOf(Error);
  });

  it('R26 — a token from the wrong issuer is rejected', async () => {
    const verify = openIdJwtLogin.verifyOpenIdAccessToken;
    await expect(
      verify(sign(keyA, { iss: 'https://evil.example.test/realms/audittrace' }), openIdConfig),
    ).rejects.toBeInstanceOf(Error);
  });

  it('R27 — a token whose azp is another client is rejected', async () => {
    const verify = openIdJwtLogin.verifyOpenIdAccessToken;
    await expect(
      verify(sign(keyA, { azp: 'audittrace-opencode' }), openIdConfig),
    ).rejects.toBeInstanceOf(Error);
  });
  it('R27b — an ID token (typ ID) is not an access token: rejected even when signed by the realm key with the right azp (A4)', async () => {
    const verify = openIdJwtLogin.verifyOpenIdAccessToken;
    await expect(verify(sign(keyA, { typ: 'ID' }), openIdConfig)).rejects.toBeInstanceOf(Error);
  });

  it('R27c — an HS256 token is rejected: only RS256 is accepted (algorithm confusion)', async () => {
    const verify = openIdJwtLogin.verifyOpenIdAccessToken;
    const hs = jwt.sign(
      { sub: 'kc-sub-A', iss: ISSUER, azp: CLIENT, typ: 'Bearer', exp: T0_S + 300 },
      pem(keyA.publicKey, 'spki'),
      {
        algorithm: 'HS256',
        keyid: 'kid-A',
        noTimestamp: true,
      },
    );
    await expect(verify(hs, openIdConfig)).rejects.toBeInstanceOf(Error);
  });

  it('R27d — a token that is not a JWT is rejected before any JWKS request', async () => {
    const verify = openIdJwtLogin.verifyOpenIdAccessToken;
    await expect(verify('opaque-access-token', openIdConfig)).rejects.toBeInstanceOf(Error);
    expect(mockGetSigningKey).not.toHaveBeenCalled();
  });

  it('R27e — a JWKS that cannot be reached surfaces the client error unchanged (the caller tells it from a refusal)', async () => {
    const verify = openIdJwtLogin.verifyOpenIdAccessToken;
    mockGetSigningKey.mockRejectedValueOnce(
      Object.assign(new Error('jwks down'), { name: 'JwksError' }),
    );
    await expect(verify(sign(keyA, {}), openIdConfig)).rejects.toMatchObject({ name: 'JwksError' });
  });

  it('R27f — one JWKS client serves every verification of a jwksUri (its key cache can hit)', async () => {
    const verify = openIdJwtLogin.verifyOpenIdAccessToken;
    await verify(sign(keyA, {}), openIdConfig);
    await verify(sign(keyA, {}), openIdConfig);
    expect(jwksRsa).toHaveBeenCalledTimes(1);
    expect(mockGetSigningKey).toHaveBeenCalledTimes(2);
  });
});
