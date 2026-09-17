/**
 * Conversation-Tags-ON-THE-BASE regression tests (MongoDB-elimination
 * EPIC — the FIRST domain built behind `AuditTraceSovereignAdapter` from
 * its very first commit, per
 * `2026-09-17-SPEC-ADDENDUM-conv-tags-shim-folds-behind-the-adapter-
 * base.md`). Mocks ONLY the HTTP boundary (`./client`) and the logger;
 * the base, this domain's declaration, and the shared `requestContext`
 * are REAL, unmocked code.
 *
 * Every disclosed carve-out named in `index.js`'s module docstring is a
 * named test here (§1 addToConversation, §2 rename/position, §3 delete
 * side-effect gap, §4 residual filter, §5 updateTagsForConversation
 * unwired). Every guard this domain itself introduces (G1 the
 * `deleteConversationTags` shape check, G2 the own-user fail-closed
 * check, the idempotent-create no-op) is pinned with a SIDE-EFFECT
 * assertion — see the build record for the manual neuter/restore table.
 */
const fs = require('fs');
const path = require('path');

jest.mock('./client', () => ({ callConsoleConversationTagsProxy: jest.fn() }));
jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { callConsoleConversationTagsProxy } = require('./client');
const { logger } = require('@librechat/data-schemas');
const { runWithRequestAccessToken } = require('../AuditTraceConversations/requestContext');
const { SovereignMemoryError, MissingAccessTokenError } = require('../AuditTraceMemory/errors');
const { AuditTraceSovereignAdapter } = require('../AuditTraceSovereignAdapter');
const {
  AuditTraceConversationTagsAdapter,
  conversationTagsAdapter,
  SOVEREIGN_METHOD_BINDERS,
  LIST_PAGE_SIZE,
  LIST_MAX_PAGES,
} = require('./index');

const notFound = () => new SovereignMemoryError('not found', 404);

const row = (tag, extra = {}) => ({
  tag,
  description: `${tag} description`,
  count: 0,
  position: 1,
  created_at_ms: 1,
  updated_at_ms: 2,
  deleted_at_ms: null,
  metadata: {},
  ...extra,
});

/** Binds a chokepointed method the way `wrapModelMethods` does. */
const bind = (name, mongoFn = jest.fn(), mongoMethods = {}) =>
  SOVEREIGN_METHOD_BINDERS[name]('tok', mongoFn, mongoMethods);

const withToken = (fn) => runWithRequestAccessToken({ accessToken: 'tok', sub: 'lc-user-1' }, fn);

describe('AuditTraceConversationTags — the conversation-tags domain ON the sovereign adapter base', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('the domain is THIN — it declares, it does not re-implement', () => {
    it('is a subclass of the base; the module hand-rolls no ALS, no backend branch, no owner-key classifier', () => {
      expect(conversationTagsAdapter).toBeInstanceOf(AuditTraceSovereignAdapter);
      expect(conversationTagsAdapter).toBeInstanceOf(AuditTraceConversationTagsAdapter);
      const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
      expect(src).not.toMatch(/new\s+AsyncLocalStorage/);
      expect(src).not.toMatch(/isSovereignBackend/);
      expect(src).not.toMatch(/filter\.user\b/);
      expect(conversationTagsAdapter.idField).toBe('tag');
      expect(conversationTagsAdapter.idAliases).toEqual([]);
      expect(conversationTagsAdapter.batchGet).toBeNull();
      expect(conversationTagsAdapter.list).toEqual({
        pageSize: LIST_PAGE_SIZE,
        maxPages: LIST_MAX_PAGES,
      });
    });

    it('names exactly the 6 wired methods (updateTagsForConversation is DISCLOSED-UNWIRED) with the Mongo arities', () => {
      expect(Object.keys(SOVEREIGN_METHOD_BINDERS).sort()).toEqual(
        [
          'bulkIncrementTagCounts',
          'createConversationTag',
          'deleteConversationTag',
          'deleteConversationTags',
          'getConversationTags',
          'updateConversationTag',
        ].sort(),
      );
      expect('updateTagsForConversation' in SOVEREIGN_METHOD_BINDERS).toBe(false);
      const arity = (name) => SOVEREIGN_METHOD_BINDERS[name]('t', jest.fn(), {}).length;
      expect(arity('getConversationTags')).toBe(1);
      expect(arity('createConversationTag')).toBe(2);
      expect(arity('updateConversationTag')).toBe(3);
      expect(arity('deleteConversationTag')).toBe(2);
      expect(arity('deleteConversationTags')).toBe(1);
      expect(arity('bulkIncrementTagCounts')).toBe(2);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('getConversationTags — own-list, sorted by position', () => {
    it('serves the sovereign list re-sorted by position ascending (the store orders newest-first)', async () => {
      callConsoleConversationTagsProxy.mockResolvedValueOnce({
        items: [row('c', { position: 3 }), row('a', { position: 1 }), row('b', { position: 2 })],
        next_cursor: null,
      });
      const tags = await withToken(() => bind('getConversationTags')('lc-user-1'));
      expect(tags.map((t) => t.tag)).toEqual(['a', 'b', 'c']);
    });

    it("an invalid (undefined) user is the base's unsafe-filter short-circuit: [] and Mongo is NEVER called (fail-closed, matches invariant 4 — raw Mongo would have stripped the key and returned every user's tags)", async () => {
      const mongoFn = jest.fn().mockResolvedValue([{ tag: 'legacy' }]);
      const result = await withToken(() => bind('getConversationTags', mongoFn)(undefined));
      expect(result).toEqual([]);
      expect(callConsoleConversationTagsProxy).not.toHaveBeenCalled();
      expect(mongoFn).not.toHaveBeenCalled();
    });

    it('a DEFINED-but-not-a-non-empty-string user is a residual (safe) filter — defers to Mongo via the fallback (unmapped rows, so a missing `position` sorts as 0), unlike the unsafe undefined case above', async () => {
      const mongoFn = jest
        .fn()
        .mockResolvedValue([
          { tag: 'high', position: 10 },
          { tag: 'nopos' },
          { tag: 'low', position: -1 },
        ]);
      const result = await withToken(() => bind('getConversationTags', mongoFn)(''));
      expect(result.map((t) => t.tag)).toEqual(['low', 'nopos', 'high']);
      expect(callConsoleConversationTagsProxy).not.toHaveBeenCalled();
      expect(mongoFn).toHaveBeenCalledWith('');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('createConversationTag — idempotent-if-exists; new tag gets maxPosition+1', () => {
    it("an EXISTING tag is returned UNCHANGED — description/count/position from the call are IGNORED (Mongo's own no-op contract)", async () => {
      callConsoleConversationTagsProxy.mockResolvedValueOnce(
        row('work', { description: 'original', count: 5, position: 1 }),
      );
      const result = await withToken(() =>
        bind('createConversationTag')('lc-user-1', {
          tag: 'work',
          description: 'a NEW description that must NOT be persisted',
          count: 999,
        }),
      );
      expect(result.description).toBe('original');
      expect(result.count).toBe(5);
      // Only the GET (readOne) happened — no POST upsert was ever sent.
      expect(callConsoleConversationTagsProxy).toHaveBeenCalledTimes(1);
      expect(callConsoleConversationTagsProxy.mock.calls[0][0].method).toBe('GET');
    });

    it("a NEW tag is created at maxPosition+1 over the caller's own existing tags — a malformed own-list entry with no position is skipped, and a later LOWER position does not lower the running max", async () => {
      callConsoleConversationTagsProxy
        .mockRejectedValueOnce(notFound()) // readOne('newtag') miss
        .mockResolvedValueOnce({
          items: [row('a', { position: 5 }), { tag: 'malformed' }, row('c', { position: 2 })],
          next_cursor: null,
        }) // listOwn page 1
        .mockResolvedValueOnce(row('newtag', { position: 6, count: 0 })); // create

      const result = await withToken(() =>
        bind('createConversationTag')('lc-user-1', { tag: 'newtag', description: 'd' }),
      );
      expect(result.tag).toBe('newtag');
      const createCall = callConsoleConversationTagsProxy.mock.calls.find(
        (c) => c[0].method === 'POST',
      );
      expect(createCall[0].body).toMatchObject({ tag: 'newtag', position: 6, count: 0 });
    });

    it('addToConversation + conversationId defers the WHOLE call to Mongo (DISCLOSED CONSEQUENCE §1) — the sovereign store is never touched', async () => {
      const mongoFn = jest.fn().mockResolvedValue({ tag: 'work', count: 1 });
      const result = await withToken(() =>
        bind('createConversationTag', mongoFn)('lc-user-1', {
          tag: 'work',
          addToConversation: true,
          conversationId: 'conv-1',
        }),
      );
      expect(result).toEqual({ tag: 'work', count: 1 });
      expect(callConsoleConversationTagsProxy).not.toHaveBeenCalled();
      expect(mongoFn).toHaveBeenCalledWith('lc-user-1', {
        tag: 'work',
        addToConversation: true,
        conversationId: 'conv-1',
      });
    });

    it('addToConversation WITHOUT a conversationId is NOT the disclosed carve-out shape — it wires normally', async () => {
      callConsoleConversationTagsProxy.mockRejectedValueOnce(notFound());
      callConsoleConversationTagsProxy.mockResolvedValueOnce({ items: [], next_cursor: null });
      callConsoleConversationTagsProxy.mockResolvedValueOnce(
        row('work', { count: 1, position: 1 }),
      );
      const mongoFn = jest.fn();
      await withToken(() =>
        bind('createConversationTag', mongoFn)('lc-user-1', {
          tag: 'work',
          addToConversation: true,
        }),
      );
      expect(mongoFn).not.toHaveBeenCalled();
    });

    it('a data bag with no usable tag defers to Mongo', async () => {
      const mongoFn = jest.fn().mockResolvedValue(null);
      const result = await withToken(() => bind('createConversationTag', mongoFn)('lc-user-1', {}));
      expect(result).toBeNull();
      expect(callConsoleConversationTagsProxy).not.toHaveBeenCalled();
      expect(mongoFn).toHaveBeenCalledWith('lc-user-1', {});
    });

    it('tolerates a null/undefined data argument (coerced to {}, deferred to Mongo, no throw)', async () => {
      const mongoFn = jest.fn().mockResolvedValue(null);
      await withToken(() => bind('createConversationTag', mongoFn)('lc-user-1', null));
      expect(mongoFn).toHaveBeenLastCalledWith('lc-user-1', {});
      await withToken(() => bind('createConversationTag', mongoFn)('lc-user-1', undefined));
      expect(mongoFn).toHaveBeenLastCalledWith('lc-user-1', {});
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('updateConversationTag — description-only is wired; rename/position defer whole (DISCLOSED CONSEQUENCE §2)', () => {
    it('a description-only change fetches-then-merges: other fields are PRESERVED', async () => {
      callConsoleConversationTagsProxy.mockResolvedValueOnce(
        row('work', { description: 'old', count: 7, position: 3 }),
      );
      callConsoleConversationTagsProxy.mockResolvedValueOnce(
        row('work', { description: 'new', count: 7, position: 3 }),
      );
      const result = await withToken(() =>
        bind('updateConversationTag')('lc-user-1', 'work', { description: 'new' }),
      );
      expect(result.description).toBe('new');
      const upsertBody = callConsoleConversationTagsProxy.mock.calls[1][0].body;
      expect(upsertBody).toMatchObject({ count: 7, position: 3, description: 'new' });
    });

    it('re-sending the SAME tag as data.tag (a no-op rename) is NOT a rename — description merge still applies, sovereign', async () => {
      callConsoleConversationTagsProxy.mockResolvedValueOnce(
        row('work', { description: 'old', count: 1, position: 1 }),
      );
      callConsoleConversationTagsProxy.mockResolvedValueOnce(
        row('work', { description: 'old', count: 1, position: 1 }),
      );
      const result = await withToken(() =>
        bind('updateConversationTag')('lc-user-1', 'work', { tag: 'work' }),
      );
      expect(result.tag).toBe('work');
      // No description passed — the merge keeps the EXISTING description
      // unchanged (descriptionOnlyMerge's `delta.description !== undefined`
      // false branch).
      const upsertBody = callConsoleConversationTagsProxy.mock.calls[1][0].body;
      expect(upsertBody).toMatchObject({ description: 'old' });
    });

    it('a rename (data.tag !== oldTag) defers the WHOLE call to Mongo — the sovereign store is never touched', async () => {
      const mongoFn = jest.fn().mockResolvedValue(row('newname'));
      const result = await withToken(() =>
        bind('updateConversationTag', mongoFn)('lc-user-1', 'oldname', { tag: 'newname' }),
      );
      expect(result.tag).toBe('newname');
      expect(callConsoleConversationTagsProxy).not.toHaveBeenCalled();
      expect(mongoFn).toHaveBeenCalledWith('lc-user-1', 'oldname', { tag: 'newname' });
    });

    it('a position change defers the WHOLE call to Mongo — the sovereign store is never touched', async () => {
      const mongoFn = jest.fn().mockResolvedValue(row('work', { position: 9 }));
      const result = await withToken(() =>
        bind('updateConversationTag', mongoFn)('lc-user-1', 'work', { position: 9 }),
      );
      expect(result.position).toBe(9);
      expect(callConsoleConversationTagsProxy).not.toHaveBeenCalled();
      expect(mongoFn).toHaveBeenCalledWith('lc-user-1', 'work', { position: 9 });
    });

    it('a null/undefined data argument is coerced to {} — not a rename/reposition, so it still wires sovereign (a no-op field update)', async () => {
      callConsoleConversationTagsProxy.mockResolvedValueOnce(row('work', { description: 'kept' }));
      callConsoleConversationTagsProxy.mockResolvedValueOnce(row('work', { description: 'kept' }));
      const result = await withToken(() =>
        bind('updateConversationTag')('lc-user-1', 'work', null),
      );
      expect(result.description).toBe('kept');
    });

    it('a tag not found sovereignly falls through to Mongo with the ORIGINAL arguments', async () => {
      callConsoleConversationTagsProxy.mockRejectedValueOnce(notFound());
      const mongoFn = jest.fn().mockResolvedValue(null);
      const result = await withToken(() =>
        bind('updateConversationTag', mongoFn)('lc-user-1', 'legacy', { description: 'd' }),
      );
      expect(result).toBeNull();
      expect(mongoFn).toHaveBeenCalledWith('lc-user-1', 'legacy', { description: 'd' });
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('deleteConversationTag — sovereign-first by id (DISCLOSED CONSEQUENCE §3 for the Mongo side-effect gap)', () => {
    it('a sovereign tag is deleted and the deleted record is returned; Mongo is never called', async () => {
      callConsoleConversationTagsProxy.mockResolvedValueOnce(row('work')); // fetchRaw
      callConsoleConversationTagsProxy.mockResolvedValueOnce(undefined); // DELETE
      const mongoFn = jest.fn();
      const result = await withToken(() =>
        bind('deleteConversationTag', mongoFn)('lc-user-1', 'work'),
      );
      expect(result.tag).toBe('work');
      expect(mongoFn).not.toHaveBeenCalled();
    });

    it('a missing tag falls through to Mongo', async () => {
      callConsoleConversationTagsProxy.mockRejectedValueOnce(notFound());
      const mongoFn = jest.fn().mockResolvedValue(row('legacy'));
      const result = await withToken(() =>
        bind('deleteConversationTag', mongoFn)('lc-user-1', 'legacy'),
      );
      expect(result.tag).toBe('legacy');
      expect(mongoFn).toHaveBeenCalledWith('lc-user-1', 'legacy');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('deleteConversationTags — G1: only the exact {user} shape is wired', () => {
    it('the live shape {user} sweeps BOTH stores and sums the counts', async () => {
      // Routed by request shape rather than call ORDER: `deleteByIds`'s
      // internal `resolveByIds` fans out a per-id fetchRaw concurrently
      // (`Promise.all`), so the exact call sequence is an implementation
      // detail of the base, not something this domain's test should pin.
      callConsoleConversationTagsProxy.mockImplementation(async ({ method, path }) => {
        if (method === 'GET' && path === '') {
          return { items: [row('a'), row('b')], next_cursor: null };
        }
        if (method === 'GET') {
          return row(path);
        }
        if (method === 'DELETE') {
          return undefined;
        }
        throw new Error(`unexpected call: ${method} ${path}`);
      });
      const mongoFn = jest.fn().mockResolvedValue(3);
      const result = await withToken(() =>
        bind('deleteConversationTags', mongoFn)({ user: 'lc-user-1' }),
      );
      expect(result).toBe(2 + 3);
      // The Mongo sweep excludes (by name) every tag the sovereign sweep
      // already deleted (2026-09-17 review "ALSO FIX": the pre-fix version
      // of this call forwarded the ORIGINAL {user} filter unchanged and
      // would double-count a tag present in both stores under the SAME
      // name — see DISCLOSED CONSEQUENCE §4 in index.js).
      expect(mongoFn).toHaveBeenCalledWith({ user: 'lc-user-1', tag: { $nin: ['a', 'b'] } });
    });

    it('excludes same-named sovereign-deleted tags from the Mongo sweep so a duplicate is not double-counted', async () => {
      // A tag named "dup" exists in BOTH stores (DISCLOSED CONSEQUENCE §1's
      // bookmark-flow duplicate shape). Without the exclusion, summing the
      // sovereign deletedCount (1) and the Mongo deletedCount (1, since
      // Mongo's OWN deleteMany would also match "dup") would report "2
      // tags deleted" for what the caller experiences as ONE tag name.
      callConsoleConversationTagsProxy.mockImplementation(async ({ method, path }) => {
        if (method === 'GET' && path === '') {
          return { items: [row('dup')], next_cursor: null };
        }
        if (method === 'GET') {
          return row(path);
        }
        if (method === 'DELETE') {
          return undefined;
        }
        throw new Error(`unexpected call: ${method} ${path}`);
      });
      const mongoFn = jest.fn().mockResolvedValue(1);
      const result = await withToken(() =>
        bind('deleteConversationTags', mongoFn)({ user: 'lc-user-1' }),
      );
      expect(mongoFn).toHaveBeenCalledWith({ user: 'lc-user-1', tag: { $nin: ['dup'] } });
      // Sovereign deletedCount (1) + whatever Mongo's OWN filtered sweep
      // reports for the NARROWED filter (asserted above to exclude "dup").
      expect(result).toBe(1 + 1);
    });

    it('when the caller has NO sovereign tags, the Mongo filter is forwarded unchanged (no empty-array narrowing noise)', async () => {
      callConsoleConversationTagsProxy.mockResolvedValue({ items: [], next_cursor: null });
      const mongoFn = jest.fn().mockResolvedValue(0);
      await withToken(() => bind('deleteConversationTags', mongoFn)({ user: 'lc-user-1' }));
      expect(mongoFn).toHaveBeenCalledWith({ user: 'lc-user-1' });
    });

    it('a tag listed by listOwn but already gone by delete-time (a benign race) counts via the deleteByIds fallback, not an error', async () => {
      callConsoleConversationTagsProxy.mockImplementation(async ({ method, path }) => {
        if (method === 'GET' && path === '') {
          return { items: [row('a')], next_cursor: null };
        }
        if (method === 'GET' && path === 'a') {
          throw notFound(); // gone by the time deleteByIds re-resolves it
        }
        throw new Error(`unexpected call: ${method} ${path}`);
      });
      const mongoFn = jest.fn().mockResolvedValue(0);
      const result = await withToken(() =>
        bind('deleteConversationTags', mongoFn)({ user: 'lc-user-1' }),
      );
      expect(result).toBe(0); // sovereign contributes 0 (the declared fallback), Mongo contributes 0
    });

    it('G1 (NEUTER TARGET): a filter naming {user} PLUS another key is NOT the delete-all-mine shape — defers whole, untouched (side effect: sovereign listOwn/deleteByIds never invoked)', async () => {
      const mongoFn = jest.fn().mockResolvedValue(1);
      const result = await withToken(() =>
        bind('deleteConversationTags', mongoFn)({ user: 'lc-user-1', tag: 'work' }),
      );
      expect(result).toBe(1);
      expect(callConsoleConversationTagsProxy).not.toHaveBeenCalled();
      expect(mongoFn).toHaveBeenCalledWith({ user: 'lc-user-1', tag: 'work' });
    });

    it('a residual filter (DISCLOSED CONSEQUENCE §4) defers to Mongo unchanged', async () => {
      const mongoFn = jest.fn().mockResolvedValue(0);
      await withToken(() => bind('deleteConversationTags', mongoFn)({ tag: 'orphaned' }));
      expect(callConsoleConversationTagsProxy).not.toHaveBeenCalled();
      expect(mongoFn).toHaveBeenCalledWith({ tag: 'orphaned' });
    });

    it('a non-number Mongo result contributes 0 rather than NaN/undefined', async () => {
      callConsoleConversationTagsProxy.mockResolvedValueOnce({ items: [], next_cursor: null });
      const mongoFn = jest.fn().mockResolvedValue(undefined);
      const result = await withToken(() =>
        bind('deleteConversationTags', mongoFn)({ user: 'lc-user-1' }),
      );
      expect(result).toBe(0);
    });

    it('a null/array filter is not the {user} shape either — defers to Mongo unchanged, no crash', async () => {
      const mongoFnNull = jest.fn().mockResolvedValue(0);
      await withToken(() => bind('deleteConversationTags', mongoFnNull)(null));
      expect(mongoFnNull).toHaveBeenCalledWith(null);

      const mongoFnArray = jest.fn().mockResolvedValue(0);
      await withToken(() => bind('deleteConversationTags', mongoFnArray)(['user']));
      expect(mongoFnArray).toHaveBeenCalledWith(['user']);
      expect(callConsoleConversationTagsProxy).not.toHaveBeenCalled();
    });
  });

  describe('deleteConversationTags — G2: the named user must match the request subject (own-list fail-closed)', () => {
    it("G2 (NEUTER TARGET): a filter naming ANOTHER user: the caller's sovereign own-list is NOT listed/swept; only Mongo runs for the named user; a warning is logged", async () => {
      const mongoFn = jest.fn().mockResolvedValue(4);
      const result = await withToken(() =>
        bind('deleteConversationTags', mongoFn)({ user: 'victim-2' }),
      );
      expect(result).toBe(4);
      // The ONLY call would be listOwn's GET if the sovereign sweep ran —
      // asserting NO sovereign call at all is the side effect this guard exists for.
      expect(callConsoleConversationTagsProxy).not.toHaveBeenCalled();
      expect(mongoFn).toHaveBeenCalledWith({ user: 'victim-2' });
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('NOT swept'));
    });

    it('a non-number Mongo result in the mismatch branch contributes 0, not NaN/undefined', async () => {
      const mongoFn = jest.fn().mockResolvedValue(undefined);
      const result = await withToken(() =>
        bind('deleteConversationTags', mongoFn)({ user: 'victim-2' }),
      );
      expect(result).toBe(0);
    });

    it('the live self-deletion shape (named user === request subject) still sweeps BOTH stores — the guard does not over-block', async () => {
      callConsoleConversationTagsProxy.mockImplementation(async ({ method, path }) => {
        if (method === 'GET' && path === '') {
          return { items: [row('a')], next_cursor: null };
        }
        if (method === 'GET') {
          return row(path);
        }
        return undefined; // DELETE
      });
      const mongoFn = jest.fn().mockResolvedValue(0);
      const result = await withToken(() =>
        bind('deleteConversationTags', mongoFn)({ user: 'lc-user-1' }),
      );
      expect(result).toBe(1);
      expect(callConsoleConversationTagsProxy).toHaveBeenCalled();
    });

    it('no token → MissingAccessTokenError BEFORE any hop, nothing called', async () => {
      await expect(
        SOVEREIGN_METHOD_BINDERS.deleteConversationTags(
          undefined,
          jest.fn(),
          {},
        )({
          user: 'victim-2',
        }),
      ).rejects.toBeInstanceOf(MissingAccessTokenError);
      expect(callConsoleConversationTagsProxy).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('bulkIncrementTagCounts — sovereign for found tags; missing tags batched to Mongo', () => {
    it('increments each sovereign tag found, and batches the ones NOT found to the raw Mongo function', async () => {
      // Each tag's `updateById` runs CONCURRENTLY (`Promise.all`), so this
      // routes by request shape rather than pinning call order.
      callConsoleConversationTagsProxy.mockImplementation(async ({ method, path }) => {
        if (method === 'GET' && path === 'a') {
          return row('a', { count: 2 });
        }
        if (method === 'GET' && path === 'legacy') {
          throw notFound();
        }
        if (method === 'POST') {
          return row('a', { count: 3 });
        }
        throw new Error(`unexpected call: ${method} ${path}`);
      });
      const mongoFn = jest.fn().mockResolvedValue(undefined);
      await withToken(() => bind('bulkIncrementTagCounts', mongoFn)('lc-user-1', ['a', 'legacy']));
      expect(mongoFn).toHaveBeenCalledWith('lc-user-1', ['legacy']);
      const upsertCall = callConsoleConversationTagsProxy.mock.calls.find(
        (c) => c[0].method === 'POST',
      );
      expect(upsertCall[0].body).toMatchObject({ count: 3 });
    });

    it('dedupes the tag list before processing', async () => {
      callConsoleConversationTagsProxy.mockResolvedValueOnce(row('a', { count: 0 }));
      callConsoleConversationTagsProxy.mockResolvedValueOnce(row('a', { count: 1 }));
      const mongoFn = jest.fn();
      await withToken(() => bind('bulkIncrementTagCounts', mongoFn)('lc-user-1', ['a', 'a']));
      const getCalls = callConsoleConversationTagsProxy.mock.calls.filter(
        (c) => c[0].method === 'GET',
      );
      expect(getCalls).toHaveLength(1);
      expect(mongoFn).not.toHaveBeenCalled();
    });

    it('an empty/invalid tags list is a no-op — nothing called', async () => {
      const mongoFn = jest.fn();
      const result = await withToken(() =>
        bind('bulkIncrementTagCounts', mongoFn)('lc-user-1', []),
      );
      expect(result).toBeUndefined();
      expect(callConsoleConversationTagsProxy).not.toHaveBeenCalled();
      expect(mongoFn).not.toHaveBeenCalled();
    });

    it('a non-array tags argument (undefined) is ALSO a no-op — nothing called', async () => {
      const mongoFn = jest.fn();
      const result = await withToken(() =>
        bind('bulkIncrementTagCounts', mongoFn)('lc-user-1', undefined),
      );
      expect(result).toBeUndefined();
      expect(callConsoleConversationTagsProxy).not.toHaveBeenCalled();
      expect(mongoFn).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('fail-closed — every wired write with NO token (no ALS) rejects 401 before any hop or fallback', () => {
    it('createConversationTag / updateConversationTag / deleteConversationTag / deleteConversationTags / bulkIncrementTagCounts', async () => {
      const noTok =
        (name) =>
        (...args) =>
          SOVEREIGN_METHOD_BINDERS[name](undefined, jest.fn(), {})(...args);
      await expect(noTok('createConversationTag')('u', { tag: 'x' })).rejects.toBeInstanceOf(
        MissingAccessTokenError,
      );
      await expect(
        noTok('updateConversationTag')('u', 'x', { description: 'd' }),
      ).rejects.toBeInstanceOf(MissingAccessTokenError);
      await expect(noTok('deleteConversationTag')('u', 'x')).rejects.toBeInstanceOf(
        MissingAccessTokenError,
      );
      await expect(noTok('deleteConversationTags')({ user: 'u' })).rejects.toBeInstanceOf(
        MissingAccessTokenError,
      );
      await expect(noTok('bulkIncrementTagCounts')('u', ['x'])).rejects.toBeInstanceOf(
        MissingAccessTokenError,
      );
      expect(callConsoleConversationTagsProxy).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('residual + errors', () => {
    it('a non-404 store error propagates unchanged — never a silent Mongo fallback', async () => {
      callConsoleConversationTagsProxy.mockRejectedValueOnce(new SovereignMemoryError('boom', 500));
      const mongoFn = jest.fn();
      await expect(
        withToken(() => bind('deleteConversationTag', mongoFn)('lc-user-1', 'work')),
      ).rejects.toMatchObject({ status: 500 });
      expect(mongoFn).not.toHaveBeenCalled();
    });
  });
});
