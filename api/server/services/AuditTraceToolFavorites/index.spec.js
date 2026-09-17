/**
 * Tool-Favorites-ON-THE-BASE regression tests (MongoDB-elimination EPIC —
 * the SECOND domain built behind `AuditTraceSovereignAdapter` from its
 * very first commit, per
 * `2026-09-17-SPEC-mongo-repl-wu-tool-favorites-fork-chokepoint-shim.md`
 * AS AMENDED by `2026-09-17-SPEC-ADDENDUM-G-derive-the-surface-table-
 * from-the-WIRE-not-from-reading.md`). Mocks ONLY the HTTP boundary
 * (`./client`) and the logger; the base, this domain's declaration, and
 * the shared `requestContext` are REAL, unmocked code — identical
 * discipline to `../AuditTraceConversationTags/index.spec.js`.
 *
 * Every disclosed consequence named in `index.js`'s module docstring is a
 * named test here (§1 cap re-shaping, §2 sovereign-only list, §3
 * discarded userId, §4 invalid-itemType defer, §5 read-then-write race,
 * §6 dual-store delete sweep). Every guard this domain itself introduces
 * (the existence pre-check gating `create`, the itemType+itemId equality
 * check, the `isNotFound` branch on the direct `callProxy` delete, the
 * cap error re-shaping) is pinned with a SIDE-EFFECT assertion — see the
 * build record for the manual neuter/restore table.
 */
const fs = require('fs');
const path = require('path');

jest.mock('./client', () => ({ callConsoleToolFavoritesProxy: jest.fn() }));
jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
  FAVORITE_ITEM_TYPES: ['builtin', 'tool', 'mcp', 'skill'],
}));

const { callConsoleToolFavoritesProxy } = require('./client');
const { logger } = require('@librechat/data-schemas');
const { runWithRequestAccessToken } = require('../AuditTraceConversations/requestContext');
const { SovereignMemoryError, MissingAccessTokenError } = require('../AuditTraceMemory/errors');
const { AuditTraceSovereignAdapter } = require('../AuditTraceSovereignAdapter');
const {
  AuditTraceToolFavoritesAdapter,
  toolFavoritesAdapter,
  TOOL_FAVORITE_SOVEREIGN_METHOD_BINDERS,
  MAX_TOOL_FAVORITES,
  LIST_PAGE_SIZE,
  LIST_MAX_PAGES,
  _internal,
} = require('./index');

const notFound = () => new SovereignMemoryError('not found', 404);
const forbidden = () => new SovereignMemoryError('forbidden', 403);
const capExceeded = () => new SovereignMemoryError('maximum of 100 tool favorites reached', 409);

const listPage = (items) => ({ items, next_cursor: null });

/** Binds a chokepointed method the way `wrapModelMethods` does. */
const bind = (name, mongoFn = jest.fn(), mongoMethods = {}) =>
  TOOL_FAVORITE_SOVEREIGN_METHOD_BINDERS[name]('tok', mongoFn, mongoMethods);

const withToken = (fn, sub = 'lc-user-1') =>
  runWithRequestAccessToken({ accessToken: 'tok', sub }, fn);

describe('AuditTraceToolFavorites — the tool-favorites domain ON the sovereign adapter base', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('the domain is THIN — it declares, it does not re-implement', () => {
    it('is a subclass of the base; the module hand-rolls no ALS, no backend branch, no owner-key classifier', () => {
      expect(toolFavoritesAdapter).toBeInstanceOf(AuditTraceSovereignAdapter);
      expect(toolFavoritesAdapter).toBeInstanceOf(AuditTraceToolFavoritesAdapter);
      const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
      expect(src).not.toMatch(/new\s+AsyncLocalStorage/);
      expect(src).not.toMatch(/isSovereignBackend/);
      expect(toolFavoritesAdapter.idField).toBe('compositeKey');
      expect(toolFavoritesAdapter.idAliases).toEqual([]);
      expect(toolFavoritesAdapter.batchGet).toBeNull();
      expect(toolFavoritesAdapter.list).toEqual({
        pageSize: LIST_PAGE_SIZE,
        maxPages: LIST_MAX_PAGES,
      });
      expect(LIST_PAGE_SIZE).toBe(MAX_TOOL_FAVORITES);
    });

    it('names exactly the 3 wired methods (no disclosed-unwired method) with the Mongo arities', () => {
      expect(Object.keys(TOOL_FAVORITE_SOVEREIGN_METHOD_BINDERS).sort()).toEqual(
        ['addToolFavorite', 'getToolFavorites', 'removeToolFavorite'].sort(),
      );
      // Mongo's own signatures are all arity 1 (a bare userId, or a single
      // destructured params object) — see `favorite.ts`.
      for (const name of Object.keys(TOOL_FAVORITE_SOVEREIGN_METHOD_BINDERS)) {
        expect(bind(name)).toHaveLength(1);
      }
    });
  });

  describe('getToolFavorites — DISCLOSED CONSEQUENCES §2/§3', () => {
    it('returns the exact {itemType, itemId} lean projection, never leaking user/user_sub/compositeKey', async () => {
      callConsoleToolFavoritesProxy.mockResolvedValueOnce(
        listPage([{ item_type: 'mcp', item_id: 'everything' }]),
      );
      const result = await withToken(() => bind('getToolFavorites')('lc-user-1'));
      expect(result).toEqual([{ itemType: 'mcp', itemId: 'everything' }]);
    });

    it('is sovereign-only: ctx.mongoFn is NEVER called for this shape (§2)', async () => {
      callConsoleToolFavoritesProxy.mockResolvedValueOnce(listPage([]));
      const mongoFn = jest.fn().mockResolvedValue([{ itemType: 'legacy', itemId: 'x' }]);
      await withToken(() => bind('getToolFavorites', mongoFn)('lc-user-1'));
      expect(mongoFn).not.toHaveBeenCalled();
    });

    it("DISCARDS a caller-supplied userId that differs from the live token subject — the fetch is always token-scoped, and the mismatched owner then fails the post-filter to EMPTY, never a stranger's row (§3, fail-safe; corrected by this test — see the module docstring's exact wording)", async () => {
      callConsoleToolFavoritesProxy.mockResolvedValueOnce(
        listPage([{ item_type: 'tool', item_id: 'mine' }]),
      );
      // 'attacker-supplied-other-id' names a DIFFERENT user than the live
      // token subject ('lc-user-1'). The base's `listOwn` call underneath
      // this is ALREADY scoped to the token regardless of this value (no
      // cross-user Mongo call is ever made) — but `matchesExtraConstraints`
      // then applies the OWNER key as a plain-equality POST-filter against
      // the record's stamped owner (the token sub), which the mismatched
      // argument fails, so the caller sees an EMPTY list, not their own
      // favorites returned "as if" they had asked correctly. Empirically
      // verified here rather than assumed from the sibling domain's prose.
      const result = await withToken(() => bind('getToolFavorites')('attacker-supplied-other-id'));
      expect(result).toEqual([]);
    });

    it('isolates per user via the live token, not the userId argument — two different tokens see two different lists', async () => {
      callConsoleToolFavoritesProxy.mockResolvedValueOnce(
        listPage([{ item_type: 'tool', item_id: 'for-a' }]),
      );
      const forA = await withToken(() => bind('getToolFavorites')('lc-user-A'), 'lc-user-A');
      callConsoleToolFavoritesProxy.mockResolvedValueOnce(
        listPage([{ item_type: 'mcp', item_id: 'for-b' }]),
      );
      const forB = await withToken(() => bind('getToolFavorites')('lc-user-B'), 'lc-user-B');
      expect(forA).toEqual([{ itemType: 'tool', itemId: 'for-a' }]);
      expect(forB).toEqual([{ itemType: 'mcp', itemId: 'for-b' }]);
    });
  });

  describe('addToolFavorite — the idempotent create-or-report-existing guard', () => {
    it('a NEW pair calls create and reports added: true (side effect: exactly one POST)', async () => {
      callConsoleToolFavoritesProxy
        .mockResolvedValueOnce(listPage([]))
        .mockResolvedValueOnce({ item_type: 'mcp', item_id: 'everything' });
      const result = await withToken(() =>
        bind('addToolFavorite')({ userId: 'lc-user-1', itemType: 'mcp', itemId: 'everything' }),
      );
      expect(result).toEqual({ ok: true, added: true });
      const postCalls = callConsoleToolFavoritesProxy.mock.calls.filter(
        ([args]) => args.method === 'POST',
      );
      expect(postCalls).toHaveLength(1);
    });

    it('an ALREADY-OWNED pair reports added: false and makes NO create call (the guard this test would catch if removed)', async () => {
      callConsoleToolFavoritesProxy.mockResolvedValueOnce(
        listPage([{ item_type: 'tool', item_id: 'dalle' }]),
      );
      const result = await withToken(() =>
        bind('addToolFavorite')({ userId: 'lc-user-1', itemType: 'tool', itemId: 'dalle' }),
      );
      expect(result).toEqual({ ok: true, added: false });
      const postCalls = callConsoleToolFavoritesProxy.mock.calls.filter(
        ([args]) => args.method === 'POST',
      );
      expect(postCalls).toHaveLength(0);
    });

    it('the existence check compares BOTH itemType AND itemId — a same-itemId-different-itemType row does NOT count as already owned', async () => {
      callConsoleToolFavoritesProxy
        .mockResolvedValueOnce(listPage([{ item_type: 'tool', item_id: 'shared-id' }]))
        .mockResolvedValueOnce({ item_type: 'skill', item_id: 'shared-id' });
      const result = await withToken(() =>
        bind('addToolFavorite')({ userId: 'lc-user-1', itemType: 'skill', itemId: 'shared-id' }),
      );
      expect(result).toEqual({ ok: true, added: true });
      const postCalls = callConsoleToolFavoritesProxy.mock.calls.filter(
        ([args]) => args.method === 'POST',
      );
      expect(postCalls).toHaveLength(1);
    });

    it("DISCLOSED CONSEQUENCE §1 — a cap rejection (409, plain string detail) is RE-SHAPED into the fork's own MAX_FAVORITES_EXCEEDED contract", async () => {
      callConsoleToolFavoritesProxy
        .mockResolvedValueOnce(listPage([]))
        .mockRejectedValueOnce(capExceeded());
      await expect(
        withToken(() =>
          bind('addToolFavorite')({
            userId: 'lc-user-1',
            itemType: 'tool',
            itemId: 'one-too-many',
          }),
        ),
      ).rejects.toMatchObject({
        code: 'MAX_FAVORITES_EXCEEDED',
        limit: MAX_TOOL_FAVORITES,
        message: `Maximum of ${MAX_TOOL_FAVORITES} favorites reached`,
      });
    });

    it('a NON-cap error from create propagates UNCHANGED (never re-shaped, never swallowed)', async () => {
      callConsoleToolFavoritesProxy
        .mockResolvedValueOnce(listPage([]))
        .mockRejectedValueOnce(forbidden());
      await expect(
        withToken(() =>
          bind('addToolFavorite')({ userId: 'lc-user-1', itemType: 'tool', itemId: 'x' }),
        ),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('DISCLOSED CONSEQUENCE §4 — an invalid itemType defers the WHOLE call to Mongo, no sovereign call at all', async () => {
      const mongoFn = jest.fn().mockResolvedValue({ ok: true, added: true });
      const result = await withToken(() =>
        bind('addToolFavorite', mongoFn)({ userId: 'lc-user-1', itemType: 'agent', itemId: 'x' }),
      );
      expect(result).toEqual({ ok: true, added: true });
      expect(callConsoleToolFavoritesProxy).not.toHaveBeenCalled();
      expect(mongoFn).toHaveBeenCalledWith({ userId: 'lc-user-1', itemType: 'agent', itemId: 'x' });
    });

    it('an empty itemId ALSO defers to Mongo (never a sovereign call with an unusable id)', async () => {
      const mongoFn = jest.fn().mockResolvedValue({ ok: true, added: true });
      await withToken(() =>
        bind('addToolFavorite', mongoFn)({ userId: 'lc-user-1', itemType: 'tool', itemId: '' }),
      );
      expect(callConsoleToolFavoritesProxy).not.toHaveBeenCalled();
      expect(mongoFn).toHaveBeenCalledTimes(1);
    });

    it("never sends an owner field in the create body (the base strips it; belt-and-braces check on this domain's own mapping)", async () => {
      callConsoleToolFavoritesProxy
        .mockResolvedValueOnce(listPage([]))
        .mockResolvedValueOnce({ item_type: 'mcp', item_id: 'x' });
      await withToken(() =>
        bind('addToolFavorite')({ userId: 'lc-user-1', itemType: 'mcp', itemId: 'x' }),
      );
      const [postCall] = callConsoleToolFavoritesProxy.mock.calls.filter(
        ([args]) => args.method === 'POST',
      );
      expect(postCall[0].body).toEqual({ item_type: 'mcp', item_id: 'x' });
      expect(postCall[0].body.user).toBeUndefined();
      expect(postCall[0].body.user_sub).toBeUndefined();
    });
  });

  describe('removeToolFavorite — the dual-store sweep (no deleteById/deleteByIds; DISCLOSED CONSEQUENCE §6)', () => {
    it('a sovereign hit removes true; the Mongo sweep STILL runs (side effect: mongoFn called even on success)', async () => {
      callConsoleToolFavoritesProxy.mockResolvedValueOnce(undefined);
      const mongoFn = jest.fn().mockResolvedValue({ ok: true, removed: false });
      const result = await withToken(() =>
        bind(
          'removeToolFavorite',
          mongoFn,
        )({
          userId: 'lc-user-1',
          itemType: 'mcp',
          itemId: 'everything',
        }),
      );
      expect(result).toEqual({ ok: true, removed: true });
      expect(mongoFn).toHaveBeenCalledTimes(1);
    });

    it('a sovereign 404 is swallowed as removed:false locally, then the Mongo sweep can still report removed:true', async () => {
      callConsoleToolFavoritesProxy.mockRejectedValueOnce(notFound());
      const mongoFn = jest.fn().mockResolvedValue({ ok: true, removed: true });
      const result = await withToken(() =>
        bind(
          'removeToolFavorite',
          mongoFn,
        )({
          userId: 'lc-user-1',
          itemType: 'tool',
          itemId: 'legacy-only',
        }),
      );
      expect(result).toEqual({ ok: true, removed: true });
    });

    it('neither store had the row — removed:false, both attempted', async () => {
      callConsoleToolFavoritesProxy.mockRejectedValueOnce(notFound());
      const mongoFn = jest.fn().mockResolvedValue({ ok: true, removed: false });
      const result = await withToken(() =>
        bind(
          'removeToolFavorite',
          mongoFn,
        )({
          userId: 'lc-user-1',
          itemType: 'skill',
          itemId: 'never-existed',
        }),
      );
      expect(result).toEqual({ ok: true, removed: false });
      expect(mongoFn).toHaveBeenCalledTimes(1);
    });

    it('a NON-404 sovereign error PROPAGATES — the Mongo sweep never runs (never masks a real failure as removed:false)', async () => {
      callConsoleToolFavoritesProxy.mockRejectedValueOnce(forbidden());
      const mongoFn = jest.fn();
      await expect(
        withToken(() =>
          bind(
            'removeToolFavorite',
            mongoFn,
          )({
            userId: 'lc-user-1',
            itemType: 'tool',
            itemId: 'x',
          }),
        ),
      ).rejects.toMatchObject({ status: 403 });
      expect(mongoFn).not.toHaveBeenCalled();
    });

    it('DISCLOSED CONSEQUENCE §4 — an invalid itemType defers the WHOLE call to Mongo, no sovereign call at all', async () => {
      const mongoFn = jest.fn().mockResolvedValue({ ok: true, removed: true });
      const result = await withToken(() =>
        bind('removeToolFavorite', mongoFn)({ userId: 'lc-user-1', itemType: 'nope', itemId: 'x' }),
      );
      expect(result).toEqual({ ok: true, removed: true });
      expect(callConsoleToolFavoritesProxy).not.toHaveBeenCalled();
    });

    it('never issues a GET to the {item_type}/{item_id} shape — the regression guard for the deleteById/deleteByIds pitfall (405 on the real transport)', async () => {
      callConsoleToolFavoritesProxy.mockResolvedValueOnce(undefined);
      const mongoFn = jest.fn().mockResolvedValue({ ok: true, removed: false });
      await withToken(() =>
        bind(
          'removeToolFavorite',
          mongoFn,
        )({
          userId: 'lc-user-1',
          itemType: 'mcp',
          itemId: 'everything',
        }),
      );
      const getCalls = callConsoleToolFavoritesProxy.mock.calls.filter(
        ([args]) => args.method === 'GET',
      );
      expect(getCalls).toHaveLength(0);
    });

    it('requires a token — fail-closed, no callProxy attempt without one (no explicit token, no ALS token)', async () => {
      const mongoFn = jest.fn();
      // Bypass the `bind()` test helper (which always supplies 'tok') and
      // call the binder exactly as `wrapModelMethods` would if it were
      // ever invoked with no token at all — direct, no `withToken` wrapper
      // either, so `ctx.token` AND the ALS are both empty.
      const removeToolFavorite = TOOL_FAVORITE_SOVEREIGN_METHOD_BINDERS.removeToolFavorite(
        null,
        mongoFn,
        {},
      );
      await expect(
        removeToolFavorite({ userId: 'lc-user-1', itemType: 'mcp', itemId: 'x' }),
      ).rejects.toThrow(MissingAccessTokenError);
      expect(callConsoleToolFavoritesProxy).not.toHaveBeenCalled();
      expect(mongoFn).not.toHaveBeenCalled();
    });
  });

  describe('internal helpers — direct unit coverage', () => {
    it('isValidItemType accepts exactly the closed FAVORITE_ITEM_TYPES vocabulary', () => {
      expect(_internal.isValidItemType('builtin')).toBe(true);
      expect(_internal.isValidItemType('tool')).toBe(true);
      expect(_internal.isValidItemType('mcp')).toBe(true);
      expect(_internal.isValidItemType('skill')).toBe(true);
      expect(_internal.isValidItemType('agent')).toBe(false);
      expect(_internal.isValidItemType('')).toBe(false);
      expect(_internal.isValidItemType(null)).toBe(false);
      expect(_internal.isValidItemType(undefined)).toBe(false);
      expect(_internal.isValidItemType(42)).toBe(false);
    });

    it('isCapExceeded is true ONLY for a SovereignMemoryError with status 409', () => {
      expect(_internal.isCapExceeded(capExceeded())).toBe(true);
      expect(_internal.isCapExceeded(notFound())).toBe(false);
      expect(_internal.isCapExceeded(forbidden())).toBe(false);
      expect(_internal.isCapExceeded(new Error('409-shaped but not a SovereignMemoryError'))).toBe(
        false,
      );
    });

    it('capExceededError reproduces favorite.ts::capError() byte-for-byte', () => {
      const error = _internal.capExceededError();
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe('MAX_FAVORITES_EXCEEDED');
      expect(error.limit).toBe(100);
      expect(error.message).toBe('Maximum of 100 favorites reached');
    });
  });

  describe('logging — the warning this domain emits on a sovereign miss', () => {
    it('logs a warning naming the domain when the sovereign DELETE 404s', async () => {
      callConsoleToolFavoritesProxy.mockRejectedValueOnce(notFound());
      const mongoFn = jest.fn().mockResolvedValue({ ok: true, removed: false });
      await withToken(() =>
        bind(
          'removeToolFavorite',
          mongoFn,
        )({
          userId: 'lc-user-1',
          itemType: 'tool',
          itemId: 'legacy-only',
        }),
      );
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('AuditTraceToolFavorites'));
    });
  });
});
