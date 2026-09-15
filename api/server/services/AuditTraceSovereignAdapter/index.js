/**
 * `AuditTraceSovereignAdapter` — the abstract base EVERY MongoDB-replacement
 * fork shim folds behind (MongoDB-elimination EPIC, WU-B of
 * `2026-09-13-SPEC-sovereign-store-and-adapter-abstractions`, RATIFIED
 * 2026-09-13: "use Abstract Classes or Interfaces and fold this behind our
 * implementation, for ANY of the MongoDB implementations").
 *
 * **Why a base at all.** Three consecutive files-shim REJECTs
 * (`lesson-sovereign-adapter-read-discipline-20260913`) were each a
 * DIFFERENT per-method edge of the SAME discipline, hand-written wrong
 * three different ways: v1 threw on owner reads it hadn't whitelisted;
 * v2 classified reads on "has a `user` key" and split-brained the owner's
 * own `{file_id}` reads to Mongo; the v2 fix-round let a
 * `{_id: undefined}` filter reach Mongo (Mongoose strips undefined →
 * `find({})` → ANOTHER user's document text served to the caller — F6),
 * and left `deleteFiles(ids)` Mongo-only so an own delete orphaned the
 * sovereign row (F7). A domain that hand-writes these paths WILL get one
 * of them wrong. This base OWNS every one of those invariants, ONCE,
 * proven ONCE at the base level (`index.spec.js`, each guard neutered →
 * RED via side-effect → restored GREEN), so a domain inherits the
 * discipline and structurally CANNOT reinvent it.
 *
 * ============================================================
 * THE INVARIANTS THIS BASE OWNS (frozen by the ratified spec)
 * ============================================================
 *
 *  1. **ONE `AsyncLocalStorage`, ONE chokepoint.** Token context is read
 *     through `../AuditTraceConversations/requestContext` — the SAME store
 *     `wrapModelMethods` reads. This module instantiates NO
 *     `AsyncLocalStorage` of its own and contains NO "is the flag on?"
 *     branch: the sovereign-vs-Mongo DECISION stays in
 *     `AuditTraceConversations/index.js::wrapModelMethods`, called EXACTLY
 *     ONCE from `api/models/index.js`. A domain built on this base only
 *     contributes its binders to `ALL_SOVEREIGN_METHOD_BINDERS` there.
 *
 *  2. **READ-by-id: sovereign-FIRST, RLS-scoped by the caller's live token
 *     `sub`, Mongo fall-through ONLY for ids not found there.** Classified
 *     by SHAPE (`./filters::classifyFilter` — does the filter ADDRESS
 *     id(s)?), NEVER by owner-key presence. `filter.user` is never
 *     consulted for scoping — the token IS the scope; a stale, missing or
 *     even hostile owner key in the filter changes nothing about which
 *     rows the store returns. The OWNER's own by-id reads (route-level ACL
 *     established ownership, so the filter carries no owner key) resolve
 *     from sovereign; a GENUINE cross-user read (a sharee reading another
 *     user's row) finds nothing under the caller's scope and falls to
 *     Mongo for THOSE ids only — the disclosed explicit-sharing boundary
 *     until that WU lands.
 *
 *  3. **WRITE/DELETE/UPDATE-by-id: the SAME sovereign-first-by-id
 *     discipline (F7).** `updateById`/`deleteById`/`deleteByIds` resolve
 *     the id(s) under the caller's scope first; found → sovereign;
 *     missing → the domain's Mongo fallback for the missing ids only.
 *     There is NO "Mongo-only when no owner arg was passed" path.
 *
 *  4. **Undefined/empty-key SHORT-CIRCUIT (F6 — SECURITY).** A filter that
 *     is empty or carries a present-but-`undefined` value, an id that is
 *     not a non-empty string, an empty id set — NONE of these ever reach
 *     Mongo (`readByFilter` → `[]`, `readOne`/`updateById`/`deleteById` →
 *     `null`, `deleteByIds` → `{deletedCount: 0}`, `deferToMongo` → the
 *     method's declared empty result). Mongoose would strip the key and
 *     widen the query to the whole collection; this base refuses.
 *     **The escape hatch is CLOSED, not merely unattractive (reviewer
 *     F-A1, `lesson-abstraction-must-close-the-escape-hatch-20260913`):**
 *     the `ctx.mongoFn` and every callable reachable through
 *     `ctx.mongoMethods` that `buildBinders` hands a domain `impl` are
 *     PRE-WRAPPED in `guardMongoFn` — the ONE definition of "safe to
 *     hand to Mongo" (`areMongoSafeArgs`, the same predicate
 *     `deferToMongo` applies). A domain that calls the context handle
 *     directly with a strippable filter gets the method's `emptyResult`
 *     and a logged warning. A raw Mongo CALLABLE held as an entry of the
 *     map is not reachable from a domain through `ctx` by any surface
 *     `ctx` exposes — not by call, destructuring, spread,
 *     `Object.values`/`entries`/`assign`, `Reflect.get`, the prototype
 *     chain (reviewer F-C2), a cached handle, the guard marker (symbol
 *     strip/forge), NOR by property-descriptor reflection
 *     (`Object.getOwnPropertyDescriptor(s)` / `Reflect.getOwnPropertyDescriptor`
 *     — reviewer F-B1, the one surface the first cut left open) — and the
 *     `ctx.mongoMethods` view is READ-ONLY (`set`/`defineProperty`/
 *     `deleteProperty`/`setPrototypeOf`/`preventExtensions` are refused),
 *     so a domain cannot swap a guarded entry for a raw one either.
 *     **Scope of that claim, stated exactly (reviewer F-C1/F-C3):** it
 *     covers CALLABLE entries — a callable NESTED inside a non-function
 *     entry passes through by reference and is NOT guarded (disclosed on
 *     `guardMongoMethods`; not live, the chokepoint's map is functions
 *     only). And `index.spec.js` pins every surface above with a
 *     side-effect assertion (raw function NOT called, stranger row NOT
 *     returned), so the F6 mechanism cannot be re-implemented by hand —
 *     but "pinned" is not the same claim as "independently falsifiable",
 *     and `guardMongoMethods` labels each trap as one or the other rather
 *     than asserting the stronger property for the whole set.
 *
 *  5. **Serve field data from the sovereign record already held (F6
 *     mitigation).** Every sovereign read returns the FULL mapped record —
 *     a Mongo `select` projection is accepted for signature parity and
 *     ignored (a superset, never a security concern), so a route needing
 *     e.g. a `text` column it excluded on the first read is served it from
 *     the same record instead of a second by-`_id` Mongo fetch.
 *
 *  6. **Owner identity is ALWAYS request/token-derived, never a caller
 *     argument (files-v2 F3).** `toDomain` stamps TWO fields on every
 *     mapped record: `user_sub` = the store's own value verbatim (the
 *     sovereign owner, the token's `sub`), and `[ownerField]` = the
 *     authenticated request's subject read from the ONE `AsyncLocalStorage`
 *     (`getRequestSub()` — `req.user.id` as `requireJwtAuth` set it),
 *     falling back to `user_sub` outside a request. It OVERRIDES whatever
 *     the domain mapping emitted and NEVER reads a method argument.
 *     Why the request subject and not `user_sub` for `[ownerField]`: the
 *     fork's own ACL and storage checks (`fileAccess`'s owner test,
 *     `deleteFileFromS3`'s `parsedKey.userId !== ownerId` fail-close, S3
 *     keys namespaced by `req.user.id`) compare against LibreChat's user
 *     id, which is NOT the Keycloak `sub` (`openidId`). Every row the
 *     store returns is, by RLS, the token holder's — so the request's
 *     subject IS its LibreChat-side owner. Symmetrically, `toBody` never
 *     sends an owner field: the server derives it from the bearer token.
 *
 *  7. **Fail-closed writes (and reads).** Every sovereign primitive
 *     requires a token (`requireToken`: the explicit one the chokepoint
 *     bound, else the ONE ALS) and throws `MissingAccessTokenError` BEFORE
 *     any network hop or any fallback when there is none. This base
 *     NEVER decides "no token → Mongo": that boundary (background/
 *     scheduled work with no live request) belongs to the chokepoint
 *     alone, documented there. A non-2xx from the store propagates
 *     unchanged; only a 404 READ maps to "not found" (Mongo's own
 *     no-match semantics), never a write.
 *
 *  8. **Fetch-then-merge clobber guard.** The store's upsert REPLACES the
 *     `metadata` bag wholesale; `updateById` fetches the EXISTING row,
 *     merges the delta on top (or the domain's `merge` hook), and only
 *     then builds the body — a partial update never silently drops fields
 *     the caller did not mention.
 *
 *  9. **Disclosed truncation (F8).** `listOwn` pages with a defensive
 *     ceiling (`list.maxPages * list.pageSize`); hitting it is LOGGED as a
 *     warning naming the domain, and the ceiling is a declared config
 *     value a domain must disclose in its build record — never a silent
 *     divergence from Mongo's unbounded return.
 *
 * ============================================================
 * WHAT A DOMAIN DECLARES (and nothing more)
 * ============================================================
 * A domain is a thin config/subclass: `{domain, callProxy (its BFF
 * client), idField, idAliases, ownerField, fromApi, toApiBody, batchGet
 * (or null → per-id GET), list: {pageSize, maxPages}, methods}` where
 * each `methods[name]` is `{kind: 'read'|'write'|'deferred', arity,
 * impl(args, ctx)}` and `impl` composes ONLY the base primitives
 * (`readByFilter`, `readOne`, `create`, `updateById`, `deleteById`,
 * `deleteByIds`, `listOwn`, `deferToMongo`). `buildBinders()` turns that
 * map into the fixed-arity `(token, mongoFn, mongoMethods) => (...)`
 * binders the chokepoint merges. The `ctx.mongoFn` / `ctx.mongoMethods`
 * handles an `impl` receives are NOT the raw Mongo functions: they are
 * pre-wrapped in `guardMongoFn` (invariant 4, F-A1), so even a direct
 * call from an `impl` inherits the undefined-key guard. Nothing about
 * the read/fall-through/write logic is written per domain.
 * `../AuditTraceFiles` is the FIRST and hardest adopter — the reference.
 */

const { logger } = require('@librechat/data-schemas');
const { SovereignMemoryError, MissingAccessTokenError } = require('../AuditTraceMemory/errors');
const {
  getRequestAccessToken,
  getRequestSub,
} = require('../AuditTraceConversations/requestContext');
const {
  isPlainObject,
  isNonEmptyString,
  areMongoSafeArgs,
  classifyFilter,
  narrowFilter,
  matchesExtraConstraints,
} = require('./filters');

const METHOD_KINDS = new Set(['read', 'write', 'deferred']);
const DEFAULT_LIST_PAGE_SIZE = 100;
const DEFAULT_LIST_MAX_PAGES = 50;
/** Marks a Mongo callable ALREADY wrapped by `guardMongoFn` (idempotence). */
const MONGO_GUARDED = Symbol('AuditTraceSovereignAdapter.mongoGuarded');

/** @param {unknown} error @returns {boolean} */
function isNotFound(error) {
  return error instanceof SovereignMemoryError && error.status === 404;
}

/**
 * Returns a function of EXACTLY `arity` positional parameters that
 * forwards them to `fn`. Deliberately NOT a `(...args)` spread (the
 * pre-remediation chokepoint design): different call sites invoke the
 * SAME method name with different argument counts, and a token appended
 * after a variable-length spread lands in the wrong slot — every prior
 * domain's binder map declares fixed arities for this reason; the base
 * generalizes that rule.
 *
 * @param {number} arity
 * @param {(...args: unknown[]) => unknown} fn
 * @returns {Function}
 */
function withArity(arity, fn) {
  switch (arity) {
    case 0:
      return () => fn();
    case 1:
      return (a) => fn(a);
    case 2:
      return (a, b) => fn(a, b);
    case 3:
      return (a, b, c) => fn(a, b, c);
    case 4:
      return (a, b, c, d) => fn(a, b, c, d);
    default:
      throw new TypeError(`AuditTraceSovereignAdapter: unsupported binder arity ${arity}`);
  }
}

class AuditTraceSovereignAdapter {
  /**
   * @param {object} config
   * @param {string} config.domain - short name for logs/errors (`'files'`).
   * @param {(req: {method: string, path?: string, token: string|null|undefined,
   *   query?: Record<string, string>, body?: unknown}) => Promise<unknown>} config.callProxy -
   *   the domain's thin BFF client (fail-closed on status, throws
   *   `MissingAccessTokenError` without a token).
   * @param {string} config.idField - the domain's client key (`'file_id'`).
   * @param {string[]} [config.idAliases] - other filter keys that address
   *   the same id when they carry a string (files: `['_id']`).
   * @param {string} config.ownerField - the LibreChat-shaped owner field
   *   the base stamps (`'user'`).
   * @param {(item: Record<string, unknown>) => Record<string, unknown>} config.fromApi -
   *   store row → LibreChat shape (pure; the base overrides the owner).
   * @param {(id: string, merged: Record<string, unknown>) => Record<string, unknown>} config.toApiBody -
   *   ALREADY-merged LibreChat shape → upsert body (pure).
   * @param {{path: string, bodyKey: string}|null} [config.batchGet] - the
   *   store's batch-get route, or `null` to resolve ids by per-id GET.
   * @param {{pageSize?: number, maxPages?: number}} [config.list]
   * @param {Record<string, {kind: 'read'|'write'|'deferred', arity: number,
   *   impl: (args: unknown[], ctx: object) => unknown, emptyResult?: unknown}>} config.methods
   */
  constructor(config) {
    const cfg = config || {};
    for (const key of ['domain', 'callProxy', 'idField', 'ownerField', 'fromApi', 'toApiBody']) {
      if (cfg[key] == null) {
        throw new TypeError(`AuditTraceSovereignAdapter: config.${key} is required`);
      }
    }
    if (!isPlainObject(cfg.methods) || Object.keys(cfg.methods).length === 0) {
      throw new TypeError(
        'AuditTraceSovereignAdapter: config.methods must name at least one method',
      );
    }
    for (const [name, spec] of Object.entries(cfg.methods)) {
      if (!spec || !METHOD_KINDS.has(spec.kind) || typeof spec.impl !== 'function') {
        throw new TypeError(
          `AuditTraceSovereignAdapter: methods.${name} must declare kind (read|write|deferred) and impl`,
        );
      }
      if (!Number.isInteger(spec.arity) || spec.arity < 0) {
        throw new TypeError(
          `AuditTraceSovereignAdapter: methods.${name}.arity must be a non-negative integer`,
        );
      }
    }
    this.domain = cfg.domain;
    this.callProxy = cfg.callProxy;
    this.idField = cfg.idField;
    this.idAliases = Array.isArray(cfg.idAliases) ? [...cfg.idAliases] : [];
    this.ownerField = cfg.ownerField;
    this.fromApi = cfg.fromApi;
    this.toApiBody = cfg.toApiBody;
    this.batchGet = cfg.batchGet === undefined ? null : cfg.batchGet;
    this.list = {
      pageSize: (cfg.list && cfg.list.pageSize) || DEFAULT_LIST_PAGE_SIZE,
      maxPages: (cfg.list && cfg.list.maxPages) || DEFAULT_LIST_MAX_PAGES,
    };
    this.methods = cfg.methods;
    Object.freeze(this);
  }

  // ── Identity / context (invariant 1 + 6 + 7) ───────────────────────────

  /** @returns {string|undefined} the live request token via the ONE shared ALS. */
  currentToken() {
    return getRequestAccessToken();
  }

  /** @returns {string|undefined} the authenticated request's subject via the ONE shared ALS. */
  currentSub() {
    return getRequestSub();
  }

  /**
   * The explicit token the chokepoint bound, else the live request's, else
   * a loud `MissingAccessTokenError` — NEVER a silent Mongo fallback.
   *
   * @param {string|null|undefined} token
   * @returns {string}
   */
  requireToken(token) {
    const resolved = token || this.currentToken();
    if (!resolved) {
      throw new MissingAccessTokenError(
        `[AuditTraceSovereignAdapter:${this.domain}] no access token — sovereign call refused (fail-closed)`,
      );
    }
    return resolved;
  }

  /**
   * Store row → LibreChat shape, with the owner identity FORCED from the
   * request context (invariant 6). Overrides anything `fromApi` emitted
   * for `[ownerField]`/`user_sub`; never reads a method argument.
   *
   * @param {Record<string, unknown>} item
   * @returns {Record<string, unknown>}
   */
  toDomain(item) {
    const mapped = this.fromApi(item) || {};
    const storeOwner = item.user_sub;
    return {
      ...mapped,
      user_sub: storeOwner,
      [this.ownerField]: this.currentSub() ?? storeOwner,
    };
  }

  /**
   * ALREADY-merged LibreChat shape → upsert body, with every owner field
   * stripped (the server derives the owner from the bearer token; a body
   * value would be ignored at best and is never sent).
   *
   * @param {string} id
   * @param {Record<string, unknown>} merged
   * @returns {Record<string, unknown>}
   */
  toBody(id, merged) {
    const body = { ...(this.toApiBody(id, merged) || {}) };
    delete body.user_sub;
    delete body[this.ownerField];
    return body;
  }

  // ── HTTP primitives (all fail-closed) ────────────────────────────────────

  /**
   * GET one raw store row by id under the caller's scope; `null` on 404.
   * @param {string} id @param {string} token
   * @returns {Promise<Record<string, unknown>|null>}
   */
  async fetchRaw(id, token) {
    try {
      return await this.callProxy({ method: 'GET', path: id, token });
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Resolves a set of ids under the caller's OWN scope in ONE round trip
   * when the store has a batch-get route, else by per-id GET fan-out. An
   * id the caller does not own (or that does not exist) is simply ABSENT
   * from `found` and listed in `missing` — never an error.
   *
   * @param {string[]} ids
   * @param {string} token
   * @returns {Promise<{found: Map<string, Record<string, unknown>>, missing: string[]}>}
   */
  async resolveByIds(ids, token) {
    const found = new Map();
    if (ids.length === 0) {
      return { found, missing: [] };
    }
    if (this.batchGet) {
      const resp = await this.callProxy({
        method: 'POST',
        path: this.batchGet.path,
        token,
        body: { [this.batchGet.bodyKey]: ids },
      });
      const items = Array.isArray(resp && resp.items) ? resp.items : [];
      for (const item of items) {
        found.set(item[this.idField], item);
      }
    } else {
      const rows = await Promise.all(ids.map((id) => this.fetchRaw(id, token)));
      rows.forEach((row, i) => {
        if (row != null) {
          found.set(ids[i], row);
        }
      });
    }
    return { found, missing: ids.filter((id) => !found.has(id)) };
  }

  /**
   * Every page of the caller's own rows (raw), cursor-paginated, with the
   * disclosed defensive ceiling (invariant 9).
   *
   * @param {string} token
   * @returns {Promise<Record<string, unknown>[]>}
   */
  async listOwn(token) {
    const items = [];
    let cursor;
    let page = 0;
    for (;;) {
      const query = { limit: String(this.list.pageSize) };
      if (cursor) {
        query.cursor = cursor;
      }
      const resp = await this.callProxy({ method: 'GET', path: '', token, query });
      const pageItems = Array.isArray(resp && resp.items) ? resp.items : [];
      items.push(...pageItems);
      const nextCursor = resp && resp.next_cursor;
      if (!nextCursor) {
        break;
      }
      page += 1;
      if (page >= this.list.maxPages) {
        logger.warn(
          `[AuditTraceSovereignAdapter:${this.domain}] listOwn hit the disclosed ceiling ` +
            `(${this.list.maxPages} pages x ${this.list.pageSize}); result truncated`,
        );
        break;
      }
      cursor = nextCursor;
    }
    return items;
  }

  // ── THE READ DISCIPLINE (invariants 2, 4, 5) ─────────────────────────────

  /**
   * Serves a Mongo-style filter read. `unsafe` → `[]` (never Mongo);
   * `ids` → sovereign-first under the caller's scope, `ctx.fallback`
   * (narrowed to the missing ids, or the ORIGINAL filter byte-identical
   * when every id is missing) for the rest; `own-list` → the sovereign
   * list endpoint; `residual` → `ctx.fallback(filter)` unchanged.
   * Sovereign rows are post-filtered with the filter's extra keys.
   *
   * @param {unknown} filter
   * @param {{token?: string|null, fallback: (filter: Record<string, unknown>) => Promise<unknown[]|null|undefined>}} ctx
   * @returns {Promise<Record<string, unknown>[]>}
   */
  async readByFilter(filter, ctx) {
    const token = this.requireToken(ctx.token);
    const shape = classifyFilter(filter, this);
    if (shape.kind === 'unsafe') {
      logger.warn(
        `[AuditTraceSovereignAdapter:${this.domain}] readByFilter short-circuited an unsafe filter ` +
          '(empty, undefined-valued, or non-id-shaped id key) — Mongo NOT consulted',
      );
      return [];
    }
    if (shape.kind === 'residual') {
      return (await ctx.fallback(filter)) || [];
    }
    if (shape.kind === 'own-list') {
      const items = await this.listOwn(token);
      return items
        .map((item) => this.toDomain(item))
        .filter((record) => matchesExtraConstraints(record, filter, this));
    }
    const { found, missing } = await this.resolveByIds(shape.ids, token);
    const own = shape.ids
      .filter((id) => found.has(id))
      .map((id) => this.toDomain(found.get(id)))
      .filter((record) => matchesExtraConstraints(record, filter, this));
    let fallback = [];
    if (missing.length === shape.ids.length) {
      fallback = (await ctx.fallback(filter)) || [];
    } else if (missing.length > 0) {
      fallback = (await ctx.fallback(narrowFilter(filter, shape.key, missing))) || [];
    }
    return [...own, ...fallback];
  }

  /**
   * One row by id: non-string/empty id → `null` (never Mongo); found →
   * the full mapped record; missing → `ctx.fallback()`.
   *
   * @param {unknown} id
   * @param {{token?: string|null, fallback: () => Promise<unknown>}} ctx
   * @returns {Promise<Record<string, unknown>|null>}
   */
  async readOne(id, ctx) {
    const token = this.requireToken(ctx.token);
    if (!isNonEmptyString(id)) {
      return null;
    }
    const raw = await this.fetchRaw(id, token);
    if (raw == null) {
      return (await ctx.fallback()) ?? null;
    }
    return this.toDomain(raw);
  }

  // ── THE WRITE DISCIPLINE (invariants 3, 4, 7, 8) ─────────────────────────

  /**
   * Creates the caller's own row — sovereign ONLY, fail-closed, no Mongo
   * path at all.
   *
   * @param {string} id
   * @param {Record<string, unknown>} data
   * @param {{token?: string|null}} ctx
   * @returns {Promise<Record<string, unknown>>}
   */
  async create(id, data, ctx) {
    const token = this.requireToken(ctx && ctx.token);
    if (!isNonEmptyString(id)) {
      throw new SovereignMemoryError(
        `[AuditTraceSovereignAdapter:${this.domain}] create requires a non-empty ${this.idField}`,
        400,
      );
    }
    const item = await this.callProxy({
      method: 'POST',
      path: '',
      token,
      body: this.toBody(id, data || {}),
    });
    return this.toDomain(item);
  }

  /**
   * Updates one row by id, sovereign-first: non-string id → `null` (never
   * Mongo); found → fetch-then-merge (`ctx.merge(existing, delta)` or a
   * shallow spread) → upsert; missing → `ctx.fallback()`.
   *
   * @param {unknown} id
   * @param {Record<string, unknown>} delta
   * @param {{token?: string|null, fallback: () => Promise<unknown>,
   *   merge?: (existing: Record<string, unknown>, delta: Record<string, unknown>) => Record<string, unknown>}} ctx
   * @returns {Promise<Record<string, unknown>|null>}
   */
  async updateById(id, delta, ctx) {
    const token = this.requireToken(ctx.token);
    if (!isNonEmptyString(id)) {
      return null;
    }
    const existingRaw = await this.fetchRaw(id, token);
    if (existingRaw == null) {
      return (await ctx.fallback()) ?? null;
    }
    const existing = this.toDomain(existingRaw);
    const merged =
      typeof ctx.merge === 'function'
        ? ctx.merge(existing, delta || {})
        : { ...existing, ...(delta || {}) };
    const updated = await this.callProxy({
      method: 'POST',
      path: '',
      token,
      body: this.toBody(id, merged),
    });
    return this.toDomain(updated);
  }

  /**
   * Deletes one row by id, sovereign-first: non-string id → `null`;
   * found → sovereign DELETE (a 404 at delete time — already gone —
   * defers to `ctx.fallback()` like a miss); missing → `ctx.fallback()`.
   * Returns the deleted record (Mongo's `findOneAndDelete` contract).
   *
   * @param {unknown} id
   * @param {{token?: string|null, fallback: () => Promise<unknown>}} ctx
   * @returns {Promise<Record<string, unknown>|null>}
   */
  async deleteById(id, ctx) {
    const token = this.requireToken(ctx.token);
    if (!isNonEmptyString(id)) {
      return null;
    }
    const existingRaw = await this.fetchRaw(id, token);
    if (existingRaw == null) {
      return (await ctx.fallback()) ?? null;
    }
    try {
      await this.callProxy({ method: 'DELETE', path: id, token });
    } catch (error) {
      if (isNotFound(error)) {
        return (await ctx.fallback()) ?? null;
      }
      throw error;
    }
    return this.toDomain(existingRaw);
  }

  /**
   * Deletes a SET of ids, sovereign-first (F7): ids sanitized to
   * non-empty strings (deduped); none → `{deletedCount: 0}` with no Mongo
   * call; found → sovereign DELETE each (404 tolerated); missing →
   * `ctx.fallback(missingIds)` whose `deletedCount` is added.
   *
   * @param {unknown} ids
   * @param {{token?: string|null, fallback: (missing: string[]) => Promise<{deletedCount?: number}|null|undefined>}} ctx
   * @returns {Promise<{deletedCount: number}>}
   */
  async deleteByIds(ids, ctx) {
    const token = this.requireToken(ctx.token);
    const clean = Array.isArray(ids) ? [...new Set(ids.filter(isNonEmptyString))] : [];
    if (clean.length === 0) {
      return { deletedCount: 0 };
    }
    const { found, missing } = await this.resolveByIds(clean, token);
    let deletedCount = 0;
    for (const id of clean) {
      if (!found.has(id)) {
        continue;
      }
      try {
        await this.callProxy({ method: 'DELETE', path: id, token });
        deletedCount += 1;
      } catch (error) {
        if (!isNotFound(error)) {
          throw error;
        }
      }
    }
    if (missing.length > 0) {
      const result = await ctx.fallback(missing);
      deletedCount += result && typeof result.deletedCount === 'number' ? result.deletedCount : 0;
    }
    return { deletedCount };
  }

  // ── The ONE Mongo argument guard (invariant 4 for opaque args; F-A1) ─────

  /**
   * THE ONE definition of "safe to hand to Mongo". Returns `mongoFn`
   * wrapped so that a call whose plain-object arguments carry a
   * present-but-`undefined` key NEVER reaches Mongo: it is logged and
   * resolves to `emptyResult` instead (`areMongoSafeArgs` — this is the
   * only call site of that predicate; `deferToMongo` and the `ctx`
   * handles `buildBinders` emits both go through here, so there is no
   * second, divergent rule). Closing the escape hatch (reviewer F-A1):
   * a domain `impl` is handed ONLY guarded callables, so calling
   * `ctx.mongoFn(filter)` directly with `{_id: undefined}` cannot
   * reproduce the F6 whole-collection read. Idempotent — an
   * already-guarded callable is returned as-is (no double wrap, one
   * warning); a non-function passes through untouched.
   *
   * @param {Function|unknown} mongoFn
   * @param {{name?: string, emptyResult?: unknown}} [meta]
   * @returns {Function|unknown}
   */
  guardMongoFn(mongoFn, meta = {}) {
    if (typeof mongoFn !== 'function' || mongoFn[MONGO_GUARDED]) {
      return mongoFn;
    }
    const { name = 'deferToMongo', emptyResult } = meta;
    const guarded = async (...args) => {
      if (!areMongoSafeArgs(args)) {
        logger.warn(
          `[AuditTraceSovereignAdapter:${this.domain}] ${name} short-circuited an argument ` +
            'with an undefined-valued key — Mongo NOT consulted',
        );
        return emptyResult;
      }
      return mongoFn(...args);
    };
    guarded[MONGO_GUARDED] = true;
    return guarded;
  }

  /**
   * Forwards a DEFERRED (disclosed Mongo-native) call to the Mongo
   * function through `guardMongoFn`: an argument with a
   * present-but-`undefined` key yields the method's declared
   * `emptyResult` and Mongo is NOT consulted.
   *
   * @param {{mongoFn: Function, emptyResult?: unknown, name?: string}} ctx
   * @param {unknown[]} args
   * @returns {Promise<unknown>}
   */
  async deferToMongo(ctx, args) {
    return this.guardMongoFn(ctx.mongoFn, ctx)(...args);
  }

  // ── Binder registration (invariant 1) ────────────────────────────────────

  /**
   * The domain's `SOVEREIGN_METHOD_BINDERS` map for the ONE chokepoint:
   * `name → (token, mongoFn, mongoMethods) => <fixed-arity fn>`. Each
   * bound call runs `methods[name].impl(args, ctx)` with
   * `ctx = {token, mongoFn, mongoMethods, emptyResult, name}`; a `write`
   * or `read` impl composes the base primitives above, a `deferred` impl
   * composes `deferToMongo`.
   *
   * **`ctx.mongoFn` and `ctx.mongoMethods` are PRE-WRAPPED (F-A1).**
   * `mongoFn` is `guardMongoFn(mongoFn)` with this method's
   * `emptyResult`; `mongoMethods` is a lazy, read-only Proxy over the
   * chokepoint's full map that guards each callable on access — through
   * `[[Get]]`, `[[GetOwnProperty]]` (F-B1) AND `[[GetPrototypeOf]]`
   * (F-C2) — with the sibling's own declared `emptyResult` when it is a
   * method of this domain. A raw map ENTRY is not reachable from an
   * `impl` through any surface of `ctx`; a callable nested inside a
   * non-function entry is (disclosed, F-C3). See `guardMongoMethods` for
   * the per-trap falsifiability labels and the surface table in
   * `index.spec.js`.
   *
   * @returns {Record<string, (token: string|null|undefined, mongoFn: Function, mongoMethods: Record<string, Function>) => Function>}
   */
  buildBinders() {
    const binders = {};
    for (const [name, spec] of Object.entries(this.methods)) {
      // `async` so a guard that THROWS inside `impl` (e.g. a 400 on a
      // missing id) surfaces as a rejected promise — the SAME contract
      // every Mongo model method has — never as a synchronous throw a
      // `.catch()`-style caller would miss.
      binders[name] = (token, mongoFn, mongoMethods) =>
        withArity(spec.arity, async (...args) =>
          spec.impl.call(this, args, {
            name,
            kind: spec.kind,
            token,
            mongoFn: this.guardMongoFn(mongoFn, { name, emptyResult: spec.emptyResult }),
            mongoMethods: this.guardMongoMethods(mongoMethods || {}),
            emptyResult: spec.emptyResult,
          }),
        );
    }
    return binders;
  }

  /**
   * A lazy, READ-ONLY view over the chokepoint's Mongo method map in
   * which every callable is `guardMongoFn`-wrapped on access (F-A1).
   * Non-function entries pass through (see DISCLOSED, below); key
   * enumeration is unchanged.
   *
   * **How to read this enumeration (reviewer F-C1/F-D1,
   * `lesson-neuter-guards-individually-20260913`).** Every surface below
   * is CLOSED, and every one is pinned by a side-effect assertion in
   * `index.spec.js`. But "closed" and "independently falsifiable" are
   * different claims, and only one of them survives a single-trap neuter.
   * So each row is labelled:
   *
   *  - **PINNED** — removing THIS trap alone turns a named test RED on the
   *    side effect (the raw function is called / the stranger row comes
   *    back). Proven one trap at a time, restoring byte-identically
   *    between runs — never in aggregate.
   *  - **REDUNDANT-BUT-RETAINED** — the surface is closed, but a SIBLING
   *    trap catches the case first, so removing this trap alone leaves the
   *    suite GREEN. Kept as defence-in-depth. The sibling is named. This
   *    row is NOT claimed to be independently falsifiable, and no test
   *    asserts that it is.
   *
   * Closed surfaces:
   *  - `get` — **PINNED.** A plain/destructured/spread/`Object.values`/
   *    `Reflect.get`/cached read yields the guarded callable.
   *  - `getOwnPropertyDescriptor` (F-B1) — **PINNED.**
   *    `Object.getOwnPropertyDescriptor(s)` /
   *    `Reflect.getOwnPropertyDescriptor` would otherwise forward to the
   *    target and hand back the UNWRAPPED function in `.value`; the trap
   *    returns a data descriptor whose `value` is the guarded callable.
   *    The chokepoint map's properties are ordinary configurable data
   *    properties, so no Proxy invariant is touched; were the map ever
   *    frozen, the engine would throw a `TypeError` here rather than let
   *    the trap report a value that differs from a non-configurable,
   *    non-writable original — fail-closed by construction, never a leak.
   *  - `getPrototypeOf` (F-C2) — **PINNED.** `Object.getPrototypeOf(view)`
   *    would otherwise forward to the target; against a target whose
   *    prototype carries callables (`Object.create({leak})`, a class
   *    instance) the returned prototype hands back the UNWRAPPED function.
   *    The trap reports `Object.prototype`, the prototype a plain map has.
   *  - `defineProperty` — **PINNED** for DATA-descriptor targets (the
   *    chokepoint's actual shape: plain function values). `Object.defineProperty`,
   *    `Object.defineProperties` and strict-mode assignment onto a
   *    data-descriptor property all end at `Receiver.[[DefineOwnProperty]]`
   *    (`OrdinarySetWithOwnDescriptor` reaches it only when the resolved
   *    descriptor `IsDataDescriptor`). **It is NOT the terminal refuser of
   *    every write surface** (a round-3 claim that was FALSE, reviewer
   *    F-D1): for an ACCESSOR-descriptor property — own OR inherited —
   *    `[[Set]]` calls the setter directly and returns WITHOUT ever
   *    reaching `[[DefineOwnProperty]]`. See the `set` row below for the
   *    surface this trap cannot see.
   *  - `deleteProperty` / `setPrototypeOf` / `preventExtensions` —
   *    **PINNED**, one `index.spec.js` assertion each.
   *  - `set` — **PINNED** (reviewer F-D1; corrects a round-3 false claim
   *    that this trap was un-pinnable / "unreachable as a control"). The
   *    true boundary, stated exactly: for a DATA-descriptor target (the
   *    chokepoint's real map — plain function values), assignment IS
   *    caught one hop later by `defineProperty: refuse`
   *    (`OrdinarySetWithOwnDescriptor` resolves a data descriptor and
   *    calls `Receiver.[[DefineOwnProperty]]`), so for THAT shape `set:
   *    refuse` is REDUNDANT-BUT-RETAINED defence-in-depth (see the F-C1
   *    test, which pins the data-descriptor case behaviourally). But for
   *    an ACCESSOR-descriptor property — own on the target, inherited
   *    from the target's prototype, or living on a class instance's
   *    class prototype — `OrdinarySetWithOwnDescriptor` calls the setter
   *    directly with `Receiver` = the proxy and returns; `[[DefineOwnProperty]]`
   *    is never consulted, so `defineProperty: refuse` cannot see that
   *    write at all. `set: refuse` is the ONLY thing that stops it, and
   *    it is independently falsifiable there: `index.spec.js` (F-D1)
   *    neuters `set` alone against an own-accessor target, a
   *    prototype-accessor target, and a class-instance target whose
   *    class prototype carries the accessor — the setter fires (RED,
   *    side effect: the shared map mutates) in all three; restoring
   *    `set: refuse` closes all three (GREEN).
   *  - F-B5 — inherited `Object.prototype` members (`hasOwnProperty`,
   *    `toString`, `constructor`, ...) are returned verbatim instead of
   *    being `async`-wrapped: `ctx.mongoMethods.hasOwnProperty('x')` is a
   *    boolean, not a truthy Promise. **PINNED.** Only genuine
   *    `Object.prototype` members get this pass-through; anything else
   *    that is not an own key (an exotic prototype) is still guarded.
   *
   * **DISCLOSED (F-C3) — non-function entries pass through BY REFERENCE,
   * unguarded and not deep-wrapped.** The guard wraps callables; an entry
   * that is an object (`{bag: {inner: rawFn}}`) is handed to the domain as
   * itself, so a callable NESTED inside it is reachable raw. Not live: the
   * ONE chokepoint (`api/models/index.js`) passes `createMethods(...)`,
   * whose every entry is a function, and a domain cannot choose the map's
   * shape. Stated here rather than silently guarded because deep-wrapping
   * an arbitrary bag is a behaviour change no spec asked for. The
   * closure claims elsewhere in this file are scoped to CALLABLE entries
   * accordingly.
   *
   * @param {Record<string, unknown>} mongoMethods
   * @returns {Record<string, unknown>}
   */
  guardMongoMethods(mongoMethods) {
    const guardEntry = (target, key) =>
      this.guardMongoFn(Reflect.get(target, key), {
        name: String(key),
        emptyResult: this.methods[key] ? this.methods[key].emptyResult : undefined,
      });
    const refuse = () => false;
    return new Proxy(mongoMethods, {
      get: (target, key) => {
        if (!Object.hasOwn(target, key) && Object.hasOwn(Object.prototype, key)) {
          return Object.prototype[key];
        }
        return guardEntry(target, key);
      },
      getOwnPropertyDescriptor: (target, key) => {
        const desc = Reflect.getOwnPropertyDescriptor(target, key);
        if (desc === undefined) {
          return undefined;
        }
        return {
          value: guardEntry(target, key),
          writable: desc.writable === true,
          enumerable: desc.enumerable === true,
          configurable: desc.configurable === true,
        };
      },
      // F-C2 — the prototype chain is a READ surface too: without this trap
      // `Object.getPrototypeOf(view)` forwards to the target and hands back
      // the target's real prototype, whose members are UNGUARDED. The view
      // reports the prototype a plain map has. Safe against the Proxy
      // invariant: the trap result must equal the target's own prototype
      // only when the target is non-extensible, and a frozen/sealed map's
      // prototype IS `Object.prototype` here (the chokepoint builds an
      // object literal), so this never throws where the untrapped form
      // would not.
      getPrototypeOf: () => Object.prototype,
      // `set` independently closes the ACCESSOR-descriptor write path
      // that `defineProperty` cannot see — for an accessor property
      // `[[Set]]` calls the setter directly and never reaches
      // `[[DefineOwnProperty]]` (reviewer F-D1; see the docstring's
      // falsifiability breakdown above `guardMongoMethods`).
      set: refuse,
      defineProperty: refuse,
      deleteProperty: refuse,
      setPrototypeOf: refuse,
      preventExtensions: refuse,
    });
  }
}

module.exports = {
  AuditTraceSovereignAdapter,
  isNotFound,
  withArity,
};
