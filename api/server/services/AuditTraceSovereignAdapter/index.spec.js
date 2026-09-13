/**
 * BASE-LEVEL invariant tests for `AuditTraceSovereignAdapter` (WU-B of
 * `2026-09-13-SPEC-sovereign-store-and-adapter-abstractions`).
 *
 * Every invariant the base OWNS is proven HERE, against a TOY domain
 * (`widgets`) that has nothing to do with files — so the guarantee is
 * demonstrably the base's, not an accident of one adopter. Each `describe`
 * names the NEUTER that flips it RED via a SIDE-EFFECT assertion (the raw
 * Mongo fallback called / not called, the exact proxy body, the stamped
 * owner), never a call-count-only check — per
 * `feedback_vacuous_neuter_test_antipattern`. Mocks ONLY the domain's
 * HTTP boundary (`callProxy`) and the logger; the base and the shared
 * `requestContext` (the ONE `AsyncLocalStorage`) are REAL, unmocked code.
 */
const fs = require('fs');
const path = require('path');

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { logger } = require('@librechat/data-schemas');
const { AuditTraceSovereignAdapter, withArity } = require('./index');
const { runWithRequestAccessToken } = require('../AuditTraceConversations/requestContext');
const { SovereignMemoryError, MissingAccessTokenError } = require('../AuditTraceMemory/errors');

const notFound = () => new SovereignMemoryError('not found', 404);

/** A raw store row for the toy domain. */
const row = (id, extra = {}) => ({
  widget_id: id,
  user_sub: 'kc-sub-owner',
  name: `name-${id}`,
  color: 'red',
  text: `text-${id}`,
  ...extra,
});

/**
 * Builds a toy adapter. `fromApi` DELIBERATELY emits a wrong owner
 * (`'MAPPING-SUPPLIED'`) and `toApiBody` DELIBERATELY passes the owner
 * fields through — so the base's forcing/stripping is what the tests
 * observe, not the mapping's good behaviour.
 */
function makeAdapter(overrides = {}) {
  const callProxy = jest.fn();
  const adapter = new AuditTraceSovereignAdapter({
    domain: 'widgets',
    callProxy,
    idField: 'widget_id',
    idAliases: ['_id'],
    ownerField: 'user',
    fromApi: (item) => ({
      widget_id: item.widget_id,
      name: item.name,
      color: item.color,
      text: item.text,
      user: 'MAPPING-SUPPLIED',
    }),
    toApiBody: (id, merged) => ({
      widget_id: id,
      name: merged.name,
      color: merged.color,
      text: merged.text,
      user: merged.user,
      user_sub: merged.user_sub,
    }),
    batchGet: { path: 'batch-get', bodyKey: 'widget_ids' },
    list: { pageSize: 2, maxPages: 3 },
    methods: {
      getWidgets: {
        kind: 'read',
        arity: 3,
        impl(args, ctx) {
          const [filter, sort, select] = args;
          return this.readByFilter(filter, {
            ...ctx,
            fallback: (f) => ctx.mongoFn(f, sort, select),
          });
        },
      },
      deleteWidgets: {
        kind: 'write',
        arity: 1,
        impl(args, ctx) {
          return this.deleteByIds(args[0], { ...ctx, fallback: (missing) => ctx.mongoFn(missing) });
        },
      },
      sweepWidgets: {
        kind: 'deferred',
        arity: 2,
        emptyResult: null,
        impl(args, ctx) {
          return this.deferToMongo(ctx, args);
        },
      },
    },
    ...overrides,
  });
  return { adapter, callProxy };
}

describe('AuditTraceSovereignAdapter — the base owns every invariant, proven once', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('INVARIANT 1 — ONE AsyncLocalStorage, ONE chokepoint (NEUTER: give the base its own ALS → the shared-store reads below go RED)', () => {
    it('the base module instantiates NO AsyncLocalStorage and has NO backend-flag branch of its own', () => {
      const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
      expect(src).not.toMatch(/new\s+AsyncLocalStorage/);
      expect(src).not.toMatch(/require\(['"]async_hooks['"]\)/);
      expect(src).not.toMatch(/isSovereignBackend/);
      expect(src).toMatch(/AuditTraceConversations\/requestContext/);
    });

    it('currentToken()/currentSub() read the SHARED requestContext store — a value set through runWithRequestAccessToken is what the base sees', () => {
      const { adapter } = makeAdapter();
      const seen = runWithRequestAccessToken({ accessToken: 'als-token', sub: 'lc-user-1' }, () => [
        adapter.currentToken(),
        adapter.currentSub(),
      ]);
      expect(seen).toEqual(['als-token', 'lc-user-1']);
      expect(adapter.currentToken()).toBeUndefined();
      expect(adapter.currentSub()).toBeUndefined();
    });

    it('requireToken prefers the explicitly-bound token, else the shared ALS token — never fabricates one', () => {
      const { adapter } = makeAdapter();
      expect(adapter.requireToken('explicit')).toBe('explicit');
      expect(
        runWithRequestAccessToken({ accessToken: 'als-token' }, () => adapter.requireToken()),
      ).toBe('als-token');
      expect(() => adapter.requireToken(undefined)).toThrow(MissingAccessTokenError);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('INVARIANT 2 — READ-by-id is sovereign-FIRST by SHAPE (NEUTER: gate on `filter.user` presence → the no-user-key owner read below goes RED: mongoFn called)', () => {
    it('a bare {widget_id} read with NO user key is served from sovereign; the raw Mongo function is NEVER called', async () => {
      const { adapter, callProxy } = makeAdapter();
      callProxy.mockResolvedValueOnce({ items: [row('w1')] });
      const mongoFn = jest.fn();

      const result = await adapter.readByFilter(
        { widget_id: 'w1' },
        { token: 'tok', fallback: mongoFn },
      );

      expect(result).toEqual([expect.objectContaining({ widget_id: 'w1', name: 'name-w1' })]);
      expect(callProxy).toHaveBeenCalledWith({
        method: 'POST',
        path: 'batch-get',
        token: 'tok',
        body: { widget_ids: ['w1'] },
      });
      expect(mongoFn).not.toHaveBeenCalled();
    });

    it("the filter's owner key is NEVER used for scoping: the proxy body carries ids only, whatever `user` says", async () => {
      const { adapter, callProxy } = makeAdapter();
      callProxy.mockResolvedValueOnce({ items: [] });
      const mongoFn = jest.fn().mockResolvedValueOnce([]);

      await adapter.readByFilter(
        { widget_id: { $in: ['w1'] }, user: 'attacker-chosen-user' },
        { token: 'tok', fallback: mongoFn },
      );

      expect(callProxy.mock.calls[0][0].body).toEqual({ widget_ids: ['w1'] });
      expect(JSON.stringify(callProxy.mock.calls[0][0])).not.toContain('attacker-chosen-user');
    });

    it('partial hit: served ids come from sovereign, ONLY the missing ids go to Mongo with a NARROWED filter (extra keys preserved)', async () => {
      const { adapter, callProxy } = makeAdapter();
      callProxy.mockResolvedValueOnce({ items: [row('w1')] });
      const mongoFn = jest.fn().mockResolvedValueOnce([{ widget_id: 'w2', legacy: true }]);
      const filter = { widget_id: { $in: ['w1', 'w2'] }, color: 'red' };

      const result = await adapter.readByFilter(filter, { token: 'tok', fallback: mongoFn });

      expect(mongoFn).toHaveBeenCalledWith({ widget_id: { $in: ['w2'] }, color: 'red' });
      expect(result.map((r) => r.widget_id)).toEqual(['w1', 'w2']);
    });

    it("GENUINE cross-user read (nothing under the caller's scope): the ORIGINAL filter object goes to Mongo byte-identical — the disclosed explicit-sharing boundary", async () => {
      const { adapter, callProxy } = makeAdapter();
      callProxy.mockResolvedValueOnce({ items: [] });
      const mongoFn = jest.fn().mockResolvedValueOnce([{ widget_id: 'shared' }]);
      const filter = { widget_id: 'shared' };

      const result = await adapter.readByFilter(filter, { token: 'tok', fallback: mongoFn });

      expect(mongoFn.mock.calls[0][0]).toBe(filter);
      expect(result).toEqual([{ widget_id: 'shared' }]);
    });

    it('an ALIAS key carrying a string ({_id: "<id>"}) is resolved sovereign-first under the alias key and narrowed under it', async () => {
      const { adapter, callProxy } = makeAdapter();
      callProxy.mockResolvedValueOnce({ items: [row('w1')] });
      const mongoFn = jest.fn();

      const result = await adapter.readByFilter({ _id: 'w1' }, { token: 'tok', fallback: mongoFn });

      expect(result[0].widget_id).toBe('w1');
      expect(mongoFn).not.toHaveBeenCalled();
    });

    it("sovereign rows are post-filtered by the filter's extra keys ($exists/equality), Mongo untouched for the excluded ids", async () => {
      const { adapter, callProxy } = makeAdapter();
      callProxy.mockResolvedValueOnce({ items: [row('w1', { color: 'blue' }), row('w2')] });
      const mongoFn = jest.fn();

      const result = await adapter.readByFilter(
        { widget_id: { $in: ['w1', 'w2'] }, color: 'red' },
        { token: 'tok', fallback: mongoFn },
      );

      expect(result.map((r) => r.widget_id)).toEqual(['w2']);
      expect(mongoFn).not.toHaveBeenCalled();
    });

    it('own-list shape ({user: req.user.id}) is served from the sovereign LIST endpoint (all pages), never Mongo; the stamped owner equals the request subject so the equality post-filter keeps every own row', async () => {
      const { adapter, callProxy } = makeAdapter();
      callProxy
        .mockResolvedValueOnce({ items: [row('w1'), row('w2')], next_cursor: 'c2' })
        .mockResolvedValueOnce({ items: [row('w3')], next_cursor: null });
      const mongoFn = jest.fn();

      const result = await runWithRequestAccessToken({ accessToken: 'tok', sub: 'lc-user-1' }, () =>
        adapter.readByFilter({ user: 'lc-user-1' }, { token: 'tok', fallback: mongoFn }),
      );

      expect(result.map((r) => r.widget_id)).toEqual(['w1', 'w2', 'w3']);
      expect(callProxy).toHaveBeenNthCalledWith(1, {
        method: 'GET',
        path: '',
        token: 'tok',
        query: { limit: '2' },
      });
      expect(callProxy).toHaveBeenNthCalledWith(2, {
        method: 'GET',
        path: '',
        token: 'tok',
        query: { limit: '2', cursor: 'c2' },
      });
      expect(mongoFn).not.toHaveBeenCalled();
    });

    it('residual shape (no id, no owner) defers to Mongo UNCHANGED (the disclosed Mongo-native category)', async () => {
      const { adapter, callProxy } = makeAdapter();
      const mongoFn = jest.fn().mockResolvedValueOnce([{ widget_id: 'x' }]);
      const filter = { expiredAt: { $ne: null } };

      const result = await adapter.readByFilter(filter, { token: 'tok', fallback: mongoFn });

      expect(mongoFn.mock.calls[0][0]).toBe(filter);
      expect(result).toEqual([{ widget_id: 'x' }]);
      expect(callProxy).not.toHaveBeenCalled();
    });

    it("a Mongo fallback returning null/undefined is normalized to [] (Mongo's own nullable contract)", async () => {
      const { adapter, callProxy } = makeAdapter();
      callProxy.mockResolvedValueOnce({ items: [] });
      const mongoFn = jest.fn().mockResolvedValueOnce(null);
      expect(
        await adapter.readByFilter({ widget_id: 'w9' }, { token: 'tok', fallback: mongoFn }),
      ).toEqual([]);
    });

    it('readOne: found → served from sovereign incl. field data, fallback NOT called; missing → fallback', async () => {
      const { adapter, callProxy } = makeAdapter();
      callProxy.mockResolvedValueOnce(row('w1'));
      const fallback = jest.fn();
      const found = await adapter.readOne('w1', { token: 'tok', fallback });
      expect(found).toEqual(expect.objectContaining({ widget_id: 'w1', text: 'text-w1' }));
      expect(fallback).not.toHaveBeenCalled();

      callProxy.mockRejectedValueOnce(notFound());
      const legacy = jest.fn().mockResolvedValueOnce({ widget_id: 'w2', legacy: true });
      expect(await adapter.readOne('w2', { token: 'tok', fallback: legacy })).toEqual({
        widget_id: 'w2',
        legacy: true,
      });
      callProxy.mockRejectedValueOnce(notFound());
      expect(
        await adapter.readOne('w3', {
          token: 'tok',
          fallback: jest.fn().mockResolvedValue(undefined),
        }),
      ).toBeNull();
    });

    it('resolveByIds without a batch-get route falls back to per-id GET (404 → missing)', async () => {
      const { adapter, callProxy } = makeAdapter({ batchGet: null });
      callProxy.mockResolvedValueOnce(row('w1')).mockRejectedValueOnce(notFound());
      const { found, missing } = await adapter.resolveByIds(['w1', 'w2'], 'tok');
      expect([...found.keys()]).toEqual(['w1']);
      expect(missing).toEqual(['w2']);
      expect(callProxy).toHaveBeenCalledWith({ method: 'GET', path: 'w1', token: 'tok' });
    });

    it('a non-404 store error propagates unchanged (fail-closed) — never mapped to a Mongo fallback', async () => {
      const { adapter, callProxy } = makeAdapter();
      callProxy.mockRejectedValueOnce(new SovereignMemoryError('boom', 502));
      const mongoFn = jest.fn();
      await expect(
        adapter.readByFilter({ widget_id: 'w1' }, { token: 'tok', fallback: mongoFn }),
      ).rejects.toMatchObject({ status: 502 });
      expect(mongoFn).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('INVARIANT 3 — WRITE/DELETE-by-id is sovereign-FIRST too (F7) (NEUTER: `deleteByIds` → straight to fallback → the sovereign DELETE side-effect below goes RED)', () => {
    it('deleteByIds: an id the caller OWNS in sovereign is DELETED there (the F7 orphan fix); missing ids go to the Mongo fallback; counts are summed', async () => {
      const { adapter, callProxy } = makeAdapter();
      callProxy.mockResolvedValueOnce({ items: [row('own-1')] }).mockResolvedValueOnce(undefined);
      const mongoFn = jest.fn().mockResolvedValueOnce({ deletedCount: 1 });

      const result = await adapter.deleteByIds(['own-1', 'legacy-1', 'own-1'], {
        token: 'tok',
        fallback: mongoFn,
      });

      expect(callProxy).toHaveBeenCalledWith({ method: 'DELETE', path: 'own-1', token: 'tok' });
      expect(mongoFn).toHaveBeenCalledWith(['legacy-1']);
      expect(result).toEqual({ deletedCount: 2 });
    });

    it("deleteByIds: when EVERY id is the caller's own, Mongo is never consulted; a 404 at delete time is tolerated", async () => {
      const { adapter, callProxy } = makeAdapter();
      callProxy
        .mockResolvedValueOnce({ items: [row('a'), row('b')] })
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(notFound());
      const mongoFn = jest.fn();

      const result = await adapter.deleteByIds(['a', 'b'], { token: 'tok', fallback: mongoFn });

      expect(result).toEqual({ deletedCount: 1 });
      expect(mongoFn).not.toHaveBeenCalled();
    });

    it('deleteById: found → sovereign DELETE, returns the deleted record; missing → fallback; 404-at-delete → fallback', async () => {
      const { adapter, callProxy } = makeAdapter();
      callProxy.mockResolvedValueOnce(row('w1')).mockResolvedValueOnce(undefined);
      const fallback = jest.fn();
      const deleted = await adapter.deleteById('w1', { token: 'tok', fallback });
      expect(deleted).toEqual(expect.objectContaining({ widget_id: 'w1' }));
      expect(callProxy).toHaveBeenCalledWith({ method: 'DELETE', path: 'w1', token: 'tok' });
      expect(fallback).not.toHaveBeenCalled();

      callProxy.mockRejectedValueOnce(notFound());
      const legacy = jest.fn().mockResolvedValueOnce({ widget_id: 'w2', legacy: true });
      expect(await adapter.deleteById('w2', { token: 'tok', fallback: legacy })).toEqual({
        widget_id: 'w2',
        legacy: true,
      });

      callProxy.mockResolvedValueOnce(row('w3')).mockRejectedValueOnce(notFound());
      const late = jest.fn().mockResolvedValueOnce(null);
      expect(await adapter.deleteById('w3', { token: 'tok', fallback: late })).toBeNull();
      expect(late).toHaveBeenCalled();

      callProxy
        .mockResolvedValueOnce(row('w4'))
        .mockRejectedValueOnce(new SovereignMemoryError('x', 500));
      await expect(
        adapter.deleteById('w4', { token: 'tok', fallback: jest.fn() }),
      ).rejects.toMatchObject({
        status: 500,
      });
    });

    it('updateById: found → fetch-then-merge → sovereign upsert; missing → fallback (the legacy Mongo row), never a silent no-op', async () => {
      const { adapter, callProxy } = makeAdapter();
      callProxy.mockResolvedValueOnce(row('w1')).mockResolvedValueOnce(row('w1', { name: 'new' }));
      const fallback = jest.fn();
      const updated = await adapter.updateById('w1', { name: 'new' }, { token: 'tok', fallback });
      expect(updated.name).toBe('new');
      expect(callProxy).toHaveBeenNthCalledWith(2, {
        method: 'POST',
        path: '',
        token: 'tok',
        body: expect.objectContaining({ widget_id: 'w1', name: 'new' }),
      });
      expect(fallback).not.toHaveBeenCalled();

      callProxy.mockRejectedValueOnce(notFound());
      const legacy = jest.fn().mockResolvedValueOnce({ widget_id: 'w2', legacy: true });
      expect(
        await adapter.updateById('w2', { name: 'x' }, { token: 'tok', fallback: legacy }),
      ).toEqual({
        widget_id: 'w2',
        legacy: true,
      });
      callProxy.mockRejectedValueOnce(notFound());
      expect(
        await adapter.updateById(
          'w3',
          { name: 'x' },
          { token: 'tok', fallback: jest.fn().mockResolvedValue(undefined) },
        ),
      ).toBeNull();
    });

    it('create: sovereign ONLY — there is no Mongo path; a missing id is a loud 400', async () => {
      const { adapter, callProxy } = makeAdapter();
      callProxy.mockResolvedValueOnce(row('w1'));
      const created = await adapter.create('w1', { name: 'n' }, { token: 'tok' });
      expect(created.widget_id).toBe('w1');
      expect(callProxy).toHaveBeenCalledWith({
        method: 'POST',
        path: '',
        token: 'tok',
        body: expect.objectContaining({ widget_id: 'w1', name: 'n' }),
      });
      await expect(adapter.create('', { name: 'n' }, { token: 'tok' })).rejects.toMatchObject({
        status: 400,
      });
      await expect(adapter.create(undefined, {}, { token: 'tok' })).rejects.toMatchObject({
        status: 400,
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('INVARIANT 4 — undefined/empty-key SHORT-CIRCUIT (F6, SECURITY) (NEUTER: drop the `unsafe` branch → every assertion below goes RED: mongoFn receives the stripped-to-{} filter)', () => {
    it.each([
      ['{_id: undefined} — the exact cross-user text-leak shape', { _id: undefined }],
      ['{widget_id: undefined}', { widget_id: undefined }],
      ['{} — an empty filter (whole collection)', {}],
      ['{widget_id: null}', { widget_id: null }],
      ['{widget_id: {$in: []}}', { widget_id: { $in: [] } }],
      [
        '{widget_id: "w1", user: undefined} — an undefined EXTRA key',
        { widget_id: 'w1', user: undefined },
      ],
      ['null', null],
      ['a string', 'w1'],
    ])(
      'readByFilter(%s) returns [] and NEVER reaches Mongo or the store',
      async (_label, filter) => {
        const { adapter, callProxy } = makeAdapter();
        const mongoFn = jest
          .fn()
          .mockResolvedValue([{ widget_id: 'ANOTHER-USERS-ROW', text: 'secret' }]);

        const result = await adapter.readByFilter(filter, { token: 'tok', fallback: mongoFn });

        expect(result).toEqual([]);
        expect(mongoFn).not.toHaveBeenCalled();
        expect(callProxy).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('short-circuited'));
      },
    );

    it.each([undefined, null, '', 42, {}])(
      'readOne/updateById/deleteById with a non-string id (%p) return null and NEVER reach Mongo or the store',
      async (badId) => {
        const { adapter, callProxy } = makeAdapter();
        const fallback = jest.fn().mockResolvedValue({ widget_id: 'ANOTHER-USERS-ROW' });
        expect(await adapter.readOne(badId, { token: 'tok', fallback })).toBeNull();
        expect(
          await adapter.updateById(badId, { name: 'x' }, { token: 'tok', fallback }),
        ).toBeNull();
        expect(await adapter.deleteById(badId, { token: 'tok', fallback })).toBeNull();
        expect(fallback).not.toHaveBeenCalled();
        expect(callProxy).not.toHaveBeenCalled();
      },
    );

    it('deleteByIds with no usable id ([undefined, "", null], [], non-array) → {deletedCount: 0}, Mongo and store untouched', async () => {
      const { adapter, callProxy } = makeAdapter();
      const mongoFn = jest.fn().mockResolvedValue({ deletedCount: 999 });
      for (const ids of [[undefined, '', null], [], undefined, 'w1']) {
        expect(await adapter.deleteByIds(ids, { token: 'tok', fallback: mongoFn })).toEqual({
          deletedCount: 0,
        });
      }
      expect(mongoFn).not.toHaveBeenCalled();
      expect(callProxy).not.toHaveBeenCalled();
    });

    it('deferToMongo forwards safe arguments unchanged, but an undefined-valued object argument yields the declared emptyResult with Mongo NOT consulted', async () => {
      const { adapter } = makeAdapter();
      const mongoFn = jest.fn().mockResolvedValueOnce('forwarded');
      expect(await adapter.deferToMongo({ mongoFn, emptyResult: null }, ['a', { k: 1 }, {}])).toBe(
        'forwarded',
      );
      expect(mongoFn).toHaveBeenCalledWith('a', { k: 1 }, {});

      const mongoFn2 = jest.fn();
      expect(
        await adapter.deferToMongo({ mongoFn: mongoFn2, emptyResult: null }, [
          { widget_id: undefined },
        ]),
      ).toBeNull();
      expect(mongoFn2).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('INVARIANT 6 — owner identity is request-derived, NEVER mapping- or caller-supplied (NEUTER: `mapped.user ?? sub` → the forced-owner assertions go RED)', () => {
    it("toDomain OVERRIDES the mapping's owner with the shared-ALS request subject, and carries the store's user_sub verbatim", () => {
      const { adapter } = makeAdapter();
      const inRequest = runWithRequestAccessToken({ accessToken: 't', sub: 'lc-user-1' }, () =>
        adapter.toDomain(row('w1')),
      );
      expect(inRequest.user).toBe('lc-user-1');
      expect(inRequest.user_sub).toBe('kc-sub-owner');
      expect(inRequest.user).not.toBe('MAPPING-SUPPLIED');
    });

    it("outside a request the owner falls back to the STORE's user_sub — never the mapping's value", () => {
      const { adapter } = makeAdapter();
      const out = adapter.toDomain(row('w1'));
      expect(out.user).toBe('kc-sub-owner');
      expect(out.user_sub).toBe('kc-sub-owner');
    });

    it('toBody STRIPS every owner field the mapping emitted — the server derives the owner from the bearer token', () => {
      const { adapter } = makeAdapter();
      const body = adapter.toBody('w1', { name: 'n', user: 'attacker', user_sub: 'attacker-sub' });
      expect(body).toEqual({ widget_id: 'w1', name: 'n', color: undefined, text: undefined });
      expect('user' in body).toBe(false);
      expect('user_sub' in body).toBe(false);
    });

    it("end to end: a create with a hostile `user` in the data never sends it, and the returned record's owner is the request subject", async () => {
      const { adapter, callProxy } = makeAdapter();
      callProxy.mockResolvedValueOnce(row('w1'));
      const created = await runWithRequestAccessToken(
        { accessToken: 'als-token', sub: 'lc-user-1' },
        () => adapter.create('w1', { name: 'n', user: 'attacker' }, {}),
      );
      expect(callProxy.mock.calls[0][0].token).toBe('als-token');
      expect('user' in callProxy.mock.calls[0][0].body).toBe(false);
      expect(created.user).toBe('lc-user-1');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('INVARIANT 7 — fail-closed: no token → MissingAccessTokenError BEFORE any hop or fallback (NEUTER: `return ctx.fallback()` on a missing token → these go RED: fallback called)', () => {
    it.each([
      ['readByFilter', (a, ctx) => a.readByFilter({ widget_id: 'w1' }, ctx)],
      ['readOne', (a, ctx) => a.readOne('w1', ctx)],
      ['create', (a, ctx) => a.create('w1', { name: 'n' }, ctx)],
      ['updateById', (a, ctx) => a.updateById('w1', { name: 'n' }, ctx)],
      ['deleteById', (a, ctx) => a.deleteById('w1', ctx)],
      ['deleteByIds', (a, ctx) => a.deleteByIds(['w1'], ctx)],
    ])(
      '%s with no explicit token and no request context rejects 401; store + fallback untouched',
      async (_name, call) => {
        const { adapter, callProxy } = makeAdapter();
        const fallback = jest.fn();
        await expect(call(adapter, { token: undefined, fallback })).rejects.toBeInstanceOf(
          MissingAccessTokenError,
        );
        expect(fallback).not.toHaveBeenCalled();
        expect(callProxy).not.toHaveBeenCalled();
      },
    );
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('INVARIANT 8 — fetch-then-merge clobber guard (NEUTER: build the body from the delta alone → the preserved-field assertion goes RED)', () => {
    it('a partial update PRESERVES every existing field the caller did not mention', async () => {
      const { adapter, callProxy } = makeAdapter();
      callProxy
        .mockResolvedValueOnce(row('w1', { color: 'red', text: 'keep-me' }))
        .mockResolvedValueOnce(row('w1'));

      await adapter.updateById('w1', { name: 'renamed' }, { token: 'tok', fallback: jest.fn() });

      expect(callProxy.mock.calls[1][0].body).toEqual({
        widget_id: 'w1',
        name: 'renamed',
        color: 'red',
        text: 'keep-me',
      });
    });

    it('a domain `merge` hook receives the EXISTING mapped record and the delta, and its result is what is persisted', async () => {
      const { adapter, callProxy } = makeAdapter();
      callProxy.mockResolvedValueOnce(row('w1')).mockResolvedValueOnce(row('w1'));
      const merge = jest.fn((existing, delta) => ({
        ...existing,
        name: `${existing.name}+${delta.suffix}`,
      }));

      await adapter.updateById('w1', { suffix: 'x' }, { token: 'tok', fallback: jest.fn(), merge });

      expect(merge).toHaveBeenCalledWith(
        expect.objectContaining({ widget_id: 'w1', name: 'name-w1' }),
        {
          suffix: 'x',
        },
      );
      expect(callProxy.mock.calls[1][0].body.name).toBe('name-w1+x');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('INVARIANT 9 — disclosed list truncation (F8) (NEUTER: remove the ceiling → the call-count and warn assertions go RED)', () => {
    it('listOwn stops at the declared ceiling and LOGS a warning naming the domain, rather than looping or truncating silently', async () => {
      const { adapter, callProxy } = makeAdapter();
      callProxy.mockResolvedValue({ items: [row('x')], next_cursor: 'more' });

      const items = await adapter.listOwn('tok');

      expect(callProxy).toHaveBeenCalledTimes(3);
      expect(items).toHaveLength(3);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          '[AuditTraceSovereignAdapter:widgets] listOwn hit the disclosed ceiling',
        ),
      );
    });

    it('listOwn tolerates a malformed page (no items array) and a fallback with no deletedCount counts 0', async () => {
      const { adapter, callProxy } = makeAdapter();
      callProxy.mockResolvedValueOnce({ next_cursor: null });
      expect(await adapter.listOwn('tok')).toEqual([]);

      callProxy.mockResolvedValueOnce({ items: [] });
      const fallback = jest.fn().mockResolvedValueOnce(undefined);
      expect(await adapter.deleteByIds(['w9'], { token: 'tok', fallback })).toEqual({
        deletedCount: 0,
      });
      expect(fallback).toHaveBeenCalledWith(['w9']);
    });

    it('listOwn with a terminating cursor chain does not warn', async () => {
      const { adapter, callProxy } = makeAdapter();
      callProxy.mockResolvedValueOnce({ items: [row('x')], next_cursor: null });
      await adapter.listOwn('tok');
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('binder registration — fixed arities, ctx threading, impl bound to the adapter', () => {
    it('buildBinders yields one fixed-arity binder per declared method; each call reaches impl with (args, ctx) and `this` = the adapter', async () => {
      const { adapter, callProxy } = makeAdapter();
      const binders = adapter.buildBinders();
      expect(Object.keys(binders).sort()).toEqual(['deleteWidgets', 'getWidgets', 'sweepWidgets']);

      const mongoFn = jest.fn();
      const bound = binders.getWidgets('tok', mongoFn, { other: jest.fn() });
      expect(bound.length).toBe(3);
      callProxy.mockResolvedValueOnce({ items: [row('w1')] });
      const result = await bound({ widget_id: 'w1' }, null, {});
      expect(result[0].widget_id).toBe('w1');
      expect(mongoFn).not.toHaveBeenCalled();

      const sweep = binders.sweepWidgets('tok', mongoFn, undefined);
      expect(sweep.length).toBe(2);
      mongoFn.mockResolvedValueOnce(7);
      expect(await sweep(1, 2)).toBe(7);
      expect(mongoFn).toHaveBeenCalledWith(1, 2);
    });

    it('a bound binder with no explicit token still fail-closes (no ALS) — the base never invents one', async () => {
      const { adapter, callProxy } = makeAdapter();
      const mongoFn = jest.fn();
      await expect(
        adapter.buildBinders().deleteWidgets(undefined, mongoFn)(['w1']),
      ).rejects.toBeInstanceOf(MissingAccessTokenError);
      expect(mongoFn).not.toHaveBeenCalled();
      expect(callProxy).not.toHaveBeenCalled();
    });

    it('withArity produces functions of exactly the declared length (0..4) and rejects the rest', () => {
      const fn = jest.fn();
      for (let n = 0; n <= 4; n += 1) {
        expect(withArity(n, fn).length).toBe(n);
      }
      withArity(4, fn)(1, 2, 3, 4);
      expect(fn).toHaveBeenCalledWith(1, 2, 3, 4);
      expect(() => withArity(5, fn)).toThrow(TypeError);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('F-A1 — the escape hatch is CLOSED: a HOSTILE impl reaching Mongo through ctx is guarded (NEUTER: hand impl the raw mongoFn/mongoMethods in buildBinders → the stranger row comes back: RED)', () => {
    /** A domain that IGNORES every base primitive and calls the ctx handle directly — the F6 mechanism by hand. */
    const hostileMethods = {
      rawRead: {
        kind: 'read',
        arity: 1,
        emptyResult: [],
        impl(args, ctx) {
          return ctx.mongoFn(args[0]);
        },
      },
      rawSibling: {
        kind: 'read',
        arity: 1,
        emptyResult: [],
        impl(args, ctx) {
          return ctx.mongoMethods.other(args[0]);
        },
      },
      rawDeclaredSibling: {
        kind: 'read',
        arity: 1,
        impl(args, ctx) {
          return ctx.mongoMethods.sweepWidgets(args[0]);
        },
      },
      sweepWidgets: {
        kind: 'deferred',
        arity: 1,
        emptyResult: null,
        impl(args, ctx) {
          return this.deferToMongo(ctx, args);
        },
      },
    };
    const stranger = [{ widget_id: 'ANOTHER-USERS-ROW', text: 'secret' }];

    it('ctx.mongoFn({_id: undefined}) from a hostile impl → the declared emptyResult, the raw Mongo function NEVER called, the stranger row NOT returned, warning names the method', async () => {
      const { adapter } = makeAdapter({ methods: hostileMethods });
      const mongoFn = jest.fn().mockResolvedValue(stranger);
      const bound = adapter.buildBinders().rawRead('tok', mongoFn, {});

      const result = await bound({ _id: undefined });

      expect(result).toEqual([]);
      expect(result).not.toEqual(stranger);
      expect(mongoFn).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringMatching(/\[AuditTraceSovereignAdapter:widgets\] rawRead short-circuited/),
      );
    });

    it('ctx.mongoFn with a SAFE filter forwards it BYTE-IDENTICAL (same object reference) and returns what Mongo returned — behaviour preserved', async () => {
      const { adapter } = makeAdapter({ methods: hostileMethods });
      const mongoFn = jest.fn().mockResolvedValue(stranger);
      const filter = { widget_id: 'w1', color: 'red' };
      const result = await adapter.buildBinders().rawRead('tok', mongoFn, {})(filter);
      expect(mongoFn).toHaveBeenCalledTimes(1);
      expect(mongoFn.mock.calls[0][0]).toBe(filter);
      expect(result).toBe(stranger);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('every callable reachable via ctx.mongoMethods is guarded too: an undeclared sibling yields undefined, a declared sibling yields ITS emptyResult, neither raw function is called; safe args still forward', async () => {
      const { adapter } = makeAdapter({ methods: hostileMethods });
      const other = jest.fn().mockResolvedValue(stranger);
      const sweepWidgets = jest.fn().mockResolvedValue(stranger);
      const binders = adapter.buildBinders();
      const methods = { other, sweepWidgets, notAFunction: 42 };

      expect(await binders.rawSibling('tok', jest.fn(), methods)({ widget_id: undefined })).toBe(
        undefined,
      );
      expect(other).not.toHaveBeenCalled();
      expect(
        await binders.rawDeclaredSibling('tok', jest.fn(), methods)({ widget_id: undefined }),
      ).toBeNull();
      expect(sweepWidgets).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(2);

      const safe = { widget_id: 'w1' };
      expect(await binders.rawSibling('tok', jest.fn(), methods)(safe)).toBe(stranger);
      expect(other.mock.calls[0][0]).toBe(safe);
      // Non-function entries and key enumeration pass through untouched.
      expect(adapter.guardMongoMethods(methods).notAFunction).toBe(42);
      expect(Object.keys(adapter.guardMongoMethods(methods))).toEqual(Object.keys(methods));
    });

    it('ONE definition of "safe to hand to Mongo": areMongoSafeArgs has exactly one call site in the base, guardMongoFn is idempotent, and deferToMongo over a pre-guarded ctx warns exactly ONCE', async () => {
      const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
      expect(src.match(/areMongoSafeArgs\(/g)).toHaveLength(1);

      const { adapter } = makeAdapter({ methods: hostileMethods });
      const raw = jest.fn();
      const once = adapter.guardMongoFn(raw, { name: 'x', emptyResult: null });
      expect(adapter.guardMongoFn(once, { name: 'x', emptyResult: null })).toBe(once);
      expect(once).not.toBe(raw);
      expect(adapter.guardMongoFn(undefined)).toBeUndefined();
      expect(adapter.guardMongoFn('not-a-fn')).toBe('not-a-fn');

      // Through a binder, a deferred impl composes deferToMongo on an
      // ALREADY-guarded ctx.mongoFn: one guard, one warning, emptyResult.
      const mongoFn = jest.fn().mockResolvedValue(stranger);
      expect(
        await adapter.buildBinders().sweepWidgets('tok', mongoFn, {})({ widget_id: undefined }),
      ).toBeNull();
      expect(mongoFn).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('sweepWidgets'));
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('F-B1 — EVERY reflective surface of ctx is closed, the property-descriptor path included (NEUTER: drop the `getOwnPropertyDescriptor` trap in guardMongoMethods → the three descriptor rows return the stranger row and call the raw sibling: RED)', () => {
    const stranger = [{ widget_id: 'ANOTHER-USERS-ROW', text: 'secret' }];

    /**
     * Each row is a way a hostile `impl` could try to get a Mongo callable
     * out of `ctx`; `reach(ctx)` (called with `this` = the adapter, as an
     * impl is) returns the callable the domain would then invoke with a
     * strippable filter. The declared sibling `sweepWidgets` and the probe
     * itself both declare `emptyResult: null`, so a GUARDED handle resolves
     * `null`; the RAW one would resolve the stranger row queued on it.
     */
    const surfaces = [
      ['direct ctx.mongoFn', (ctx) => ctx.mongoFn],
      ['lazy ctx.mongoMethods.<name>', (ctx) => ctx.mongoMethods.sweepWidgets],
      [
        'destructured {<name>} = ctx.mongoMethods',
        (ctx) => {
          const { sweepWidgets } = ctx.mongoMethods;
          return sweepWidgets;
        },
      ],
      ['spread {...ctx.mongoMethods}.<name>', (ctx) => ({ ...ctx.mongoMethods }).sweepWidgets],
      [
        'Object.assign({}, ctx.mongoMethods).<name>',
        (ctx) => Object.assign({}, ctx.mongoMethods).sweepWidgets,
      ],
      [
        'Object.values(ctx.mongoMethods)',
        (ctx) => Object.values(ctx.mongoMethods).find((v) => typeof v === 'function'),
      ],
      [
        'Object.fromEntries(Object.entries(ctx.mongoMethods)).<name>',
        (ctx) => Object.fromEntries(Object.entries(ctx.mongoMethods)).sweepWidgets,
      ],
      [
        'Reflect.get(ctx.mongoMethods, <name>)',
        (ctx) => Reflect.get(ctx.mongoMethods, 'sweepWidgets'),
      ],
      [
        'symbol strip: delete the guard marker from the handle, then call it',
        (ctx) => {
          const handle = ctx.mongoFn;
          for (const sym of Object.getOwnPropertySymbols(handle)) {
            delete handle[sym];
          }
          return handle;
        },
      ],
      [
        'symbol forge: stamp the marker taken from ctx.mongoFn onto a hand-made ctx handed to deferToMongo',
        function forge(ctx) {
          const [marker] = Object.getOwnPropertySymbols(ctx.mongoFn);
          const handle = ctx.mongoMethods.sweepWidgets;
          handle[marker] = true;
          return (filter) => this.deferToMongo({ ...ctx, mongoFn: handle }, [filter]);
        },
      ],
      [
        'Object.getOwnPropertyDescriptor(ctx.mongoMethods, <name>).value  (F-B1)',
        (ctx) => Object.getOwnPropertyDescriptor(ctx.mongoMethods, 'sweepWidgets').value,
      ],
      [
        'Object.getOwnPropertyDescriptors(ctx.mongoMethods).<name>.value  (F-B1)',
        (ctx) => Object.getOwnPropertyDescriptors(ctx.mongoMethods).sweepWidgets.value,
      ],
      [
        'Reflect.getOwnPropertyDescriptor(ctx.mongoMethods, <name>).value  (F-B1)',
        (ctx) => Reflect.getOwnPropertyDescriptor(ctx.mongoMethods, 'sweepWidgets').value,
      ],
    ];

    /** A hostile domain whose ONE method reaches Mongo via `reach`. */
    const hostile = (reach) => ({
      probe: {
        kind: 'read',
        arity: 1,
        emptyResult: null,
        impl(args, ctx) {
          return reach.call(this, ctx)(args[0]);
        },
      },
      sweepWidgets: {
        kind: 'deferred',
        arity: 1,
        emptyResult: null,
        impl(args, ctx) {
          return this.deferToMongo(ctx, args);
        },
      },
    });

    it.each(surfaces)(
      '%s → the raw Mongo function is NOT called, the stranger row is NOT returned (the declared emptyResult is); the SAME surface with a SAFE filter still reaches Mongo byte-identical',
      async (_label, reach) => {
        const rawFn = jest.fn().mockResolvedValue(stranger);
        const rawSibling = jest.fn().mockResolvedValue(stranger);
        const { adapter } = makeAdapter({ methods: hostile(reach) });
        const bound = adapter
          .buildBinders()
          .probe('tok', rawFn, { sweepWidgets: rawSibling, notAFunction: 42 });

        const result = await bound({ widget_id: undefined });

        expect(result).toBeNull();
        expect(result).not.toEqual(stranger);
        expect(rawFn).not.toHaveBeenCalled();
        expect(rawSibling).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringMatching(/\[AuditTraceSovereignAdapter:widgets\] .* short-circuited/),
        );

        const safe = { widget_id: 'w1' };
        expect(await bound(safe)).toBe(stranger);
        const rawCalls = [...rawFn.mock.calls, ...rawSibling.mock.calls];
        expect(rawCalls).toHaveLength(1);
        expect(rawCalls[0][0]).toBe(safe);
      },
    );

    it("the reviewer's F-B1 proof, inverted: Object.getOwnPropertyDescriptor(ctx.mongoMethods, 'sibling').value({_id: undefined}) — the stranger row queued on the raw sibling is NOT returned and the raw sibling is NOT called; the descriptor carries the GUARDED callable with the target's attributes", async () => {
      const rawSibling = jest.fn().mockResolvedValue(stranger);
      let seen;
      const { adapter } = makeAdapter({
        methods: hostile((ctx) => {
          seen = Object.getOwnPropertyDescriptor(ctx.mongoMethods, 'sibling');
          return seen.value;
        }),
      });
      const target = { sibling: rawSibling };

      const result = await adapter.buildBinders().probe('tok', jest.fn(), target)({
        _id: undefined,
      });

      expect(result).not.toEqual(stranger);
      expect(result).toBeUndefined(); // an undeclared sibling has no emptyResult
      expect(rawSibling).not.toHaveBeenCalled();
      expect(seen.value).not.toBe(rawSibling);
      expect(Object.getOwnPropertySymbols(seen.value)).toHaveLength(1); // the guard marker
      expect(seen).toMatchObject({ writable: true, enumerable: true, configurable: true });
      // The target itself is untouched — the guarded value lives only in the view.
      expect(Object.getOwnPropertyDescriptor(target, 'sibling').value).toBe(rawSibling);
      // A cached handle taken from the descriptor stays guarded on a later call too.
      expect(await seen.value({ widget_id: undefined })).toBeUndefined();
      expect(rawSibling).not.toHaveBeenCalled();
      // Non-existent keys report non-existent through the trap.
      expect(
        Object.getOwnPropertyDescriptor(adapter.guardMongoMethods(target), 'nope'),
      ).toBeUndefined();
    });

    it('cached-before-use: a handle cached from a SAFE first call and reused with a strippable filter is still guarded (the guard is on the handle, not on the call)', async () => {
      const rawSibling = jest.fn().mockResolvedValue(stranger);
      let cached;
      const { adapter } = makeAdapter({
        methods: hostile((ctx) => {
          cached = cached || ctx.mongoMethods.sweepWidgets;
          return cached;
        }),
      });
      const bound = adapter.buildBinders().probe('tok', jest.fn(), { sweepWidgets: rawSibling });
      const safe = { widget_id: 'w1' };
      expect(await bound(safe)).toBe(stranger);
      expect(rawSibling).toHaveBeenCalledTimes(1);
      expect(await bound({ widget_id: undefined })).toBeNull();
      expect(rawSibling).toHaveBeenCalledTimes(1);
    });

    it('the view is READ-ONLY: set/defineProperty/deleteProperty/setPrototypeOf/preventExtensions are refused and the SHARED target map is untouched — a domain cannot swap a guarded entry for a raw one', async () => {
      const rawSibling = jest.fn().mockResolvedValue(stranger);
      const injected = jest.fn().mockResolvedValue(stranger);
      const { adapter } = makeAdapter();
      const target = { sweepWidgets: rawSibling };
      const view = adapter.guardMongoMethods(target);

      expect(() => Object.defineProperty(view, 'sweepWidgets', { value: injected })).toThrow(
        TypeError,
      );
      expect(() => Object.defineProperty(view, 'injected', { value: injected })).toThrow(TypeError);
      expect(Reflect.set(view, 'sweepWidgets', injected)).toBe(false);
      expect(Reflect.set(view, 'injected', injected)).toBe(false);
      expect(Reflect.deleteProperty(view, 'sweepWidgets')).toBe(false);
      expect(Reflect.setPrototypeOf(view, { leak: injected })).toBe(false);
      expect(Reflect.preventExtensions(view)).toBe(false);
      expect(() => Object.freeze(view)).toThrow(TypeError);

      expect(Object.keys(target)).toEqual(['sweepWidgets']);
      expect(target.sweepWidgets).toBe(rawSibling);
      expect(Object.isExtensible(target)).toBe(true);
      expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(view)).toBe(Object.prototype);
      expect(Reflect.get(Object.getPrototypeOf(view), 'sweepWidgets')).toBeUndefined();

      expect(await view.sweepWidgets({ widget_id: undefined })).toBeNull();
      expect(rawSibling).not.toHaveBeenCalled();
      expect(injected).not.toHaveBeenCalled();
    });

    it('F-B5: inherited Object.prototype members are returned verbatim (hasOwnProperty is a boolean, constructor is Object), while a function on an EXOTIC prototype is still guarded', async () => {
      const rawSibling = jest.fn().mockResolvedValue(stranger);
      const { adapter } = makeAdapter();
      const view = adapter.guardMongoMethods({ sweepWidgets: rawSibling });

      // eslint-disable-next-line no-prototype-builtins -- the inherited call IS the surface under test
      const own = view.hasOwnProperty('sweepWidgets');
      // eslint-disable-next-line no-prototype-builtins -- the inherited call IS the surface under test
      const notOwn = view.hasOwnProperty('nope');
      // Without the pass-through the trap hands back an `async` wrapper whose
      // detached call (`hasOwnProperty` with no `this`) REJECTS; settle both
      // so a neutered trap fails the assertions below instead of killing the
      // jest worker with an unhandled rejection.
      await Promise.allSettled([own, notOwn]);
      expect(own).toBe(true);
      expect(notOwn).toBe(false);
      expect(view.constructor).toBe(Object);
      expect(view.toString()).toBe('[object Object]');
      expect(view.nope).toBeUndefined();

      const exotic = Object.create({ leak: rawSibling });
      const exoticView = adapter.guardMongoMethods(exotic);
      expect(await exoticView.leak({ widget_id: undefined })).toBeUndefined();
      expect(rawSibling).not.toHaveBeenCalled();
    });

    it('a FROZEN target cannot be guarded silently: the engine throws TypeError on read and on descriptor access rather than let the trap report a substitute — fail-closed, never a leak', () => {
      const rawSibling = jest.fn().mockResolvedValue(stranger);
      const { adapter } = makeAdapter();
      const view = adapter.guardMongoMethods(Object.freeze({ sweepWidgets: rawSibling }));
      expect(() => view.sweepWidgets).toThrow(TypeError);
      expect(() => Object.getOwnPropertyDescriptor(view, 'sweepWidgets')).toThrow(TypeError);
      expect(rawSibling).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('config validation — a domain cannot instantiate an incomplete base', () => {
    it('rejects a missing required field, an empty methods map, an unknown kind, a missing impl, a bad arity', () => {
      const good = () => makeAdapter();
      expect(good).not.toThrow();
      expect(() => makeAdapter({ callProxy: null })).toThrow(/callProxy is required/);
      expect(() => makeAdapter({ methods: {} })).toThrow(/at least one method/);
      expect(() => makeAdapter({ methods: { x: { kind: 'nope', arity: 1, impl() {} } } })).toThrow(
        /kind/,
      );
      expect(() => makeAdapter({ methods: { x: { kind: 'read', arity: 1 } } })).toThrow(/impl/);
      expect(() => makeAdapter({ methods: { x: { kind: 'read', arity: -1, impl() {} } } })).toThrow(
        /arity/,
      );
      expect(() => new AuditTraceSovereignAdapter()).toThrow(/domain is required/);
    });

    it('defaults: no aliases, no batch-get, 100x50 list ceiling; the instance is frozen', () => {
      const adapter = new AuditTraceSovereignAdapter({
        domain: 'd',
        callProxy: jest.fn(),
        idField: 'id',
        ownerField: 'user',
        fromApi: (i) => i,
        toApiBody: (id, m) => ({ id, ...m }),
        methods: { m: { kind: 'read', arity: 0, impl() {} } },
      });
      expect(adapter.idAliases).toEqual([]);
      expect(adapter.batchGet).toBeNull();
      expect(adapter.list).toEqual({ pageSize: 100, maxPages: 50 });
      expect(Object.isFrozen(adapter)).toBe(true);
    });
  });
});
