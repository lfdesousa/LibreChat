const jwt = require('jsonwebtoken');
const cookies = require('cookie');
const openIdClient = require('openid-client');
const { logger } = require('@librechat/data-schemas');
const { SESSION_EXPIRED, REFRESH_FAILED } = require('./sessionFailureMessages');
const { classifyRefreshFailure } = require('./classifyRefreshFailure');
const { SovereignSessionError } = require('./SovereignSessionError');
const { reloadSession, saveSession } = require('./settle');
const { withSessionLock } = require('./refreshLock');

/** Verifier failures that mean "this is not our user's token" (as opposed to the JWKS being unreachable). */
const IDENTITY_REFUSAL_NAMES = new Set([
  'JsonWebTokenError',
  'TokenExpiredError',
  'NotBeforeError',
  'SigningKeyNotFoundError',
]);

/** @param {unknown} token @returns {number|undefined} the `exp` claim (seconds) of a decodable JWT */
const decodeExp = (token) => {
  if (typeof token !== 'string') {
    return undefined;
  }
  const payload = jwt.decode(token);
  return typeof payload === 'object' && payload != null && typeof payload.exp === 'number'
    ? payload.exp
    : undefined;
};

/**
 * True when the token's `exp` is within the buffer of now. An opaque or `exp`-less token is never
 * judged. `@librechat/api` is required lazily: this module sits under the request context every
 * route imports, and the package is only needed once a token actually has an `exp` to weigh.
 */
const isNearExpiry = (token) => {
  const exp = decodeExp(token);
  if (exp === undefined) {
    return false;
  }
  const { OPENID_EXPIRY_BUFFER_SECONDS } = require('@librechat/api');
  return exp * 1000 - Date.now() <= OPENID_EXPIRY_BUFFER_SECONDS * 1000;
};

const failure = (code, status, detail) => new SovereignSessionError({ code, status, detail });

/**
 * The OpenID collaborators a refresh needs: `getOpenIdConfig`, `verifyOpenIdAccessToken`
 * (the strategy's verifier) and `storeOpenIDSession`. They live in modules that sit on the
 * `~/models` import chain's far side (strategies, AuthService), and this module sits UNDER the
 * request context that `~/models` imports: a static import would close a cycle. The middleware
 * that owns authentication (`requireJwtAuth`) hands them over instead.
 *
 * @type {{
 *   getOpenIdConfig: () => import('openid-client').Configuration,
 *   verifyOpenIdAccessToken: (token: string, config: unknown) => Promise<{sub?: string}>,
 *   storeOpenIDSession: (userId: string, refreshToken: string, tenantId?: string) => Promise<unknown>,
 * } | undefined}
 */
let collaborators;

/** @param {NonNullable<typeof collaborators>} provided */
function configureTokenSource(provided) {
  collaborators = provided;
}

/** A source that was created but never configured cannot refresh: fail closed as a transport-class failure. */
const requireCollaborators = () => {
  if (!collaborators) {
    throw failure(REFRESH_FAILED, 502, 'token_source_not_configured');
  }
  return collaborators;
};

/**
 * The request's access token as a SOURCE, not a string: `current()` returns an access token
 * that is fresh now, refreshing it (as many times as the request needs) when it is within
 * `OPENID_EXPIRY_BUFFER_SECONDS` of its `exp`.
 *
 * The source holds `req`, never `req.session`: `session.reload()` REPLACES `req.session`
 * (express-session `store.createSession`), so a captured session object would go dead.
 * Per refresh, under the per-session lock shared with `refreshController`:
 * reload -> re-check -> grant -> write tokens -> save.
 *
 * Failures are the four named `SovereignSessionError` codes; a final refusal (session
 * expired, session ended, token rejected) is remembered for the life of the request so a
 * dead refresh token is never presented again.
 */
class TokenSource {
  #req;
  #refreshCount = 0;
  /** @type {SovereignSessionError|undefined} */
  #final;

  /** @param {import('express').Request} req */
  constructor(req) {
    this.#req = req;
  }

  /** @returns {Promise<string|undefined>} a fresh access token, or undefined when the session has none */
  async current() {
    const accessToken = this.#req.session?.openidTokens?.accessToken;
    if (!accessToken) {
      return undefined;
    }
    if (!isNearExpiry(accessToken)) {
      return accessToken;
    }
    if (this.#final) {
      throw this.#final;
    }
    return withSessionLock(this.#req.sessionID, () => this.#refreshLocked());
  }

  async #refreshLocked() {
    const req = this.#req;
    try {
      await reloadSession(req.session);
    } catch {
      throw this.#remember(failure(SESSION_EXPIRED, 401, 'express_session_gone'));
    }
    const stored = req.session?.openidTokens;
    if (!stored?.accessToken || !stored.refreshToken) {
      throw this.#remember(failure(SESSION_EXPIRED, 401, 'express_session_gone'));
    }
    if (!isNearExpiry(stored.accessToken)) {
      return stored.accessToken;
    }
    const refreshExp = decodeExp(stored.refreshToken);
    if (refreshExp !== undefined && refreshExp * 1000 <= Date.now()) {
      throw this.#remember(failure(SESSION_EXPIRED, 401, 'refresh_token_exp'));
    }

    const { buildOpenIDRefreshParams } = require('@librechat/api');
    const openIdConfig = requireCollaborators().getOpenIdConfig();
    let tokenset;
    try {
      tokenset = await openIdClient.refreshTokenGrant(
        openIdConfig,
        stored.refreshToken,
        buildOpenIDRefreshParams(),
      );
    } catch (error) {
      throw this.#remember(classifyRefreshFailure(error));
    }
    await this.#assertSameSubject(tokenset, openIdConfig);

    const refreshToken = tokenset.refresh_token || stored.refreshToken;
    const userId = stored.userId ?? req.user?.id?.toString();
    req.session.openidTokens = {
      ...stored,
      accessToken: tokenset.access_token,
      refreshToken,
      idToken: tokenset.id_token ?? stored.idToken,
      lastRefreshedAt: Date.now(),
      userId,
    };
    try {
      await saveSession(req.session);
    } catch {
      throw failure(REFRESH_FAILED, 502, 'session_save_failed');
    }
    await this.#storeRefreshSession(userId, refreshToken, stored.refreshToken);
    this.#refreshCount += 1;
    logger.info('[sovereign-token] refreshed', {
      refresh_count: this.#refreshCount,
      expires_in: tokenset.expires_in,
    });
    return tokenset.access_token;
  }

  /**
   * The refreshed token must belong to the user the request authenticated as: the id_token
   * claims when the grant returned one, else the strategy's JWKS verifier on the access token.
   * Anything else is a server-side misconfiguration class (`sovereign_refresh_failed`, 502).
   */
  async #assertSameSubject(tokenset, openIdConfig) {
    let sub = tokenset.claims?.()?.sub;
    if (!sub) {
      try {
        const { verifyOpenIdAccessToken } = requireCollaborators();
        sub = (await verifyOpenIdAccessToken(tokenset.access_token, openIdConfig)).sub;
      } catch (error) {
        const refused = IDENTITY_REFUSAL_NAMES.has(error?.name);
        throw failure(REFRESH_FAILED, 502, refused ? 'identity_mismatch' : 'jwks_unreachable');
      }
    }
    const bound = this.#req.user?.openidId;
    if (!bound || sub !== bound) {
      throw failure(REFRESH_FAILED, 502, 'identity_mismatch');
    }
  }

  /**
   * Persists the new refresh token's Session document and deletes the replaced token's, EXCEPT
   * when the browser's cookie still names the replaced token: that document stays until
   * `refreshController` re-issues the cookies (and removes it) or the logout does. So a long
   * turn leaves at most two documents: the cookie-named one and the current one.
   */
  async #storeRefreshSession(userId, refreshToken, replacedRefreshToken) {
    if (!userId) {
      return;
    }
    const cookieHeader = this.#req.headers?.cookie;
    const cookieNamed = cookieHeader ? cookies.parse(cookieHeader).refreshToken : undefined;
    const previous = replacedRefreshToken === cookieNamed ? undefined : replacedRefreshToken;
    try {
      await requireCollaborators().storeOpenIDSession(
        userId,
        refreshToken,
        this.#req.user?.tenantId,
        previous,
      );
    } catch {
      /** The tokens are already saved in the Express session; the document is re-created by the next browser refresh. */
      logger.warn('[sovereign-token] refresh session document not stored');
    }
  }

  #remember(error) {
    if (error.code !== REFRESH_FAILED) {
      this.#final = error;
    }
    return error;
  }
}

/** @type {WeakMap<object, TokenSource>} */
const sources = new WeakMap();

/**
 * The request's token source, created once per request. `undefined` when the request carries
 * no OpenID console session (device-flow clients), which keeps those calls on their old path.
 * @param {import('express').Request|undefined} req
 * @returns {TokenSource|undefined}
 */
function getTokenSource(req) {
  if (!req?.session?.openidTokens?.accessToken) {
    return undefined;
  }
  let source = sources.get(req);
  if (!source) {
    source = new TokenSource(req);
    sources.set(req, source);
  }
  return source;
}

/**
 * @param {import('express').Request|undefined} req
 * @returns {Promise<string|undefined>} the request's fresh access token, `undefined` without an OpenID session
 */
async function getFreshAccessToken(req) {
  return getTokenSource(req)?.current();
}

module.exports = {
  TokenSource,
  configureTokenSource,
  getTokenSource,
  getFreshAccessToken,
  decodeExp,
  isNearExpiry,
};
