/**
 * Files-ON-THE-BASE regression tests (MongoDB-elimination EPIC — the
 * reference adopter of `AuditTraceSovereignAdapter`). Mocks ONLY the HTTP
 * boundary (`./client`) and the logger; the base, the files domain
 * declaration and the shared `requestContext` are REAL, unmocked code.
 *
 * Every scenario a prior files shim was REJECTED on is a named test here:
 * v1's over-strict throw, v2's owner split-brain, the v2 fix-round's F6
 * (`{_id: undefined}` → whole-collection leak) and F7 (own delete
 * orphaning the sovereign row), plus F3 (caller-supplied owner) and F8
 * (disclosed truncation). Each asserts a SIDE-EFFECT (the raw Mongo
 * function called / not called, the exact proxy call, the stamped owner).
 */
const fs = require('fs');
const path = require('path');

jest.mock('./client', () => ({ callConsoleFileRecordsProxy: jest.fn() }));
jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { callConsoleFileRecordsProxy } = require('./client');
const { logger } = require('@librechat/data-schemas');
const { runWithRequestAccessToken } = require('../AuditTraceConversations/requestContext');
const { SovereignMemoryError, MissingAccessTokenError } = require('../AuditTraceMemory/errors');
const { AuditTraceSovereignAdapter } = require('../AuditTraceSovereignAdapter');
const {
  AuditTraceFilesAdapter,
  filesAdapter,
  SOVEREIGN_METHOD_BINDERS,
  LIST_PAGE_SIZE,
  LIST_MAX_PAGES,
} = require('./index');

const notFound = () => new SovereignMemoryError('not found', 404);

const item = (fileId, extra = {}) => ({
  file_id: fileId,
  user_sub: 'kc-sub-owner',
  filename: `${fileId}.txt`,
  type: 'text/plain',
  bytes: 3,
  usage: { count: 1 },
  temp_file_id: 'tmp',
  created_at_ms: 1,
  updated_at_ms: 2,
  metadata: { text: `text-of-${fileId}`, textFormat: 'text', source: 'text', status: 'ready' },
  ...extra,
});

/** Binds a chokepointed method the way `wrapModelMethods` does. */
const bind = (name, mongoFn = jest.fn(), mongoMethods = {}) =>
  SOVEREIGN_METHOD_BINDERS[name]('tok', mongoFn, mongoMethods);

describe('AuditTraceFiles — the files domain ON the sovereign adapter base', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('the domain is THIN — it declares, it does not re-implement', () => {
    it('is a subclass of the base; the module hand-rolls no ALS, no backend branch, no owner-key classifier', () => {
      expect(filesAdapter).toBeInstanceOf(AuditTraceSovereignAdapter);
      expect(filesAdapter).toBeInstanceOf(AuditTraceFilesAdapter);
      const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
      expect(src).not.toMatch(/new\s+AsyncLocalStorage/);
      expect(src).not.toMatch(/isSovereignBackend/);
      expect(src).not.toMatch(/isOwnScoped/);
      expect(src).not.toMatch(/filter\.user/);
      expect(filesAdapter.idField).toBe('file_id');
      expect(filesAdapter.idAliases).toEqual(['_id']);
      expect(filesAdapter.batchGet).toEqual({ path: 'batch-get', bodyKey: 'file_ids' });
      expect(filesAdapter.list).toEqual({ pageSize: LIST_PAGE_SIZE, maxPages: LIST_MAX_PAGES });
    });

    it('names exactly the 8 wired methods with the Mongo arities', () => {
      expect(Object.keys(SOVEREIGN_METHOD_BINDERS).sort()).toEqual(
        [
          'createFile',
          'deleteFile',
          'deleteFiles',
          'findFileById',
          'getFiles',
          'updateFile',
          'updateFileUsage',
          'updateFilesUsage',
        ].sort(),
      );
      const arity = (name) => SOVEREIGN_METHOD_BINDERS[name]('t', jest.fn(), {}).length;
      expect(arity('findFileById')).toBe(2);
      expect(arity('getFiles')).toBe(3);
      expect(arity('createFile')).toBe(2);
      expect(arity('updateFile')).toBe(2);
      expect(arity('updateFileUsage')).toBe(1);
      expect(arity('updateFilesUsage')).toBe(3);
      expect(arity('deleteFile')).toBe(1);
      expect(arity('deleteFiles')).toBe(2);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('v1 REJECT — own-scoped reads are SERVED, never thrown', () => {
    it('the image-tools shape {user, file_id:{$in}, height:{$exists}, width:{$exists}} is served from sovereign (post-filtered), not a 400', async () => {
      callConsoleFileRecordsProxy.mockResolvedValueOnce({
        items: [item('img', { width: 10, height: 20 }), item('doc')],
      });
      const mongoFn = jest.fn();
      const result = await runWithRequestAccessToken({ accessToken: 'tok', sub: 'u1' }, () =>
        bind('getFiles', mongoFn)(
          {
            user: 'u1',
            file_id: { $in: ['img', 'doc'] },
            height: { $exists: true },
            width: { $exists: true },
          },
          null,
          null,
        ),
      );
      expect(result.map((f) => f.file_id)).toEqual(['img']);
      expect(mongoFn).not.toHaveBeenCalled();
    });

    it('the bare {user} "all my files" shape is served from the sovereign LIST endpoint', async () => {
      callConsoleFileRecordsProxy.mockResolvedValueOnce({
        items: [item('a'), item('b')],
        next_cursor: null,
      });
      const mongoFn = jest.fn();
      const result = await runWithRequestAccessToken({ accessToken: 'tok', sub: 'u1' }, () =>
        bind('getFiles', mongoFn)({ user: 'u1' }, null, null),
      );
      expect(result.map((f) => f.file_id)).toEqual(['a', 'b']);
      expect(callConsoleFileRecordsProxy).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          path: '',
          query: { limit: String(LIST_PAGE_SIZE) },
        }),
      );
      expect(mongoFn).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('v2 REJECT — the OWNER split-brain: no-`user`-key owner reads resolve from sovereign', () => {
    it("fileAccess.js:102 shape {file_id} — the owner's own file is served; Mongo NEVER called", async () => {
      callConsoleFileRecordsProxy.mockResolvedValueOnce({ items: [item('mine')] });
      const mongoFn = jest.fn();
      const result = await bind('getFiles', mongoFn)({ file_id: 'mine' }, null, null);
      expect(result).toEqual([expect.objectContaining({ file_id: 'mine', _id: 'mine' })]);
      expect(callConsoleFileRecordsProxy).toHaveBeenCalledWith({
        method: 'POST',
        path: 'batch-get',
        token: 'tok',
        body: { file_ids: ['mine'] },
      });
      expect(mongoFn).not.toHaveBeenCalled();
    });

    it('files.js:207 DELETE-route shape {file_id:{$in}} — every own id served; only the not-mine id goes to Mongo, NARROWED', async () => {
      callConsoleFileRecordsProxy.mockResolvedValueOnce({
        items: [item('mine-1'), item('mine-2')],
      });
      const mongoFn = jest.fn().mockResolvedValueOnce([{ file_id: 'theirs', legacy: true }]);
      const result = await bind('getFiles', mongoFn)(
        { file_id: { $in: ['mine-1', 'theirs', 'mine-2'] } },
        null,
        {},
      );
      expect(result.map((f) => f.file_id)).toEqual(['mine-1', 'mine-2', 'theirs']);
      expect(mongoFn).toHaveBeenCalledWith({ file_id: { $in: ['theirs'] } }, null, {});
    });

    it('findFileById (files.js:458 preview text) — served from the sovereign record WITH text; Mongo NEVER called', async () => {
      callConsoleFileRecordsProxy.mockResolvedValueOnce(item('mine'));
      const mongoFn = jest.fn();
      const result = await bind('findFileById', mongoFn)('mine', undefined);
      expect(result.text).toBe('text-of-mine');
      expect(result.textFormat).toBe('text');
      expect(mongoFn).not.toHaveBeenCalled();
    });

    it("GENUINE cross-user read (a sharee): nothing under the caller's scope → the ORIGINAL filter goes to Mongo byte-identical (the disclosed explicit-sharing boundary)", async () => {
      callConsoleFileRecordsProxy.mockResolvedValueOnce({ items: [] });
      const mongoFn = jest.fn().mockResolvedValueOnce([{ file_id: 'shared', legacy: true }]);
      const filter = { file_id: 'shared' };
      const result = await bind('getFiles', mongoFn)(filter, null, {});
      expect(mongoFn.mock.calls[0][0]).toBe(filter);
      expect(result).toEqual([{ file_id: 'shared', legacy: true }]);
    });

    it("findFileById for a not-mine id falls through to Mongo (a non-owner's agent-shared preview)", async () => {
      callConsoleFileRecordsProxy.mockRejectedValueOnce(notFound());
      const mongoFn = jest.fn().mockResolvedValueOnce({ file_id: 'theirs', text: 'legacy' });
      expect(await bind('findFileById', mongoFn)('theirs', undefined)).toEqual({
        file_id: 'theirs',
        text: 'legacy',
      });
      expect(mongoFn).toHaveBeenCalledWith('theirs', undefined);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('F6 (SECURITY) — the {_id} text re-fetch never widens to the whole collection', () => {
    it("files.js:586 shape {_id: undefined} → [] and the raw Mongo getFiles is NEVER called (NEUTER: forward it → Mongo returns another user's text)", async () => {
      const mongoFn = jest
        .fn()
        .mockResolvedValue([{ file_id: 'STRANGER', text: 'STRANGERS-TEXT' }]);
      const result = await bind('getFiles', mongoFn)({ _id: undefined }, null, { text: 1 });
      expect(result).toEqual([]);
      expect(mongoFn).not.toHaveBeenCalled();
      expect(callConsoleFileRecordsProxy).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('short-circuited'));
    });

    it('a sovereign record carries _id = file_id, so the SAME re-fetch {_id: file._id} is an own-scoped sovereign read served WITH text — Mongo never consulted', async () => {
      callConsoleFileRecordsProxy.mockResolvedValueOnce({ items: [item('mine')] });
      const [file] = await bind('getFiles', jest.fn())({ file_id: 'mine' }, null, null);
      expect(file._id).toBe('mine');

      callConsoleFileRecordsProxy.mockResolvedValueOnce({ items: [item('mine')] });
      const mongoFn = jest.fn();
      const [textFile] = await bind('getFiles', mongoFn)({ _id: file._id }, null, { text: 1 });
      expect(textFile.text).toBe('text-of-mine');
      expect(callConsoleFileRecordsProxy).toHaveBeenLastCalledWith(
        expect.objectContaining({ path: 'batch-get', body: { file_ids: ['mine'] } }),
      );
      expect(mongoFn).not.toHaveBeenCalled();
    });

    it("a LEGACY record's real ObjectId _id stays Mongo-native (defined, one row): deferred UNCHANGED", async () => {
      const legacyId = { toHexString: () => 'a'.repeat(24) };
      const mongoFn = jest.fn().mockResolvedValueOnce([{ file_id: 'legacy', text: 't' }]);
      const filter = { _id: legacyId };
      const result = await bind('getFiles', mongoFn)(filter, null, { text: 1 });
      expect(mongoFn.mock.calls[0][0]).toBe(filter);
      expect(result).toEqual([{ file_id: 'legacy', text: 't' }]);
      expect(callConsoleFileRecordsProxy).not.toHaveBeenCalled();
    });

    it.each([
      ['findFileById', (m) => bind('findFileById', m)(undefined, undefined)],
      ['deleteFile', (m) => bind('deleteFile', m)(undefined)],
      [
        'updateFile (plain)',
        (m) => bind('updateFile', m)({ file_id: undefined, status: 'x' }, undefined),
      ],
      [
        'updateFile (CAS extraFilter)',
        (m) => bind('updateFile', m)({ status: 'x' }, { status: 'pending' }),
      ],
      ['updateFileUsage', (m) => bind('updateFileUsage', m)({ file_id: undefined })],
    ])(
      "%s with an undefined id returns null and NEVER reaches Mongo (a stripped id would update/delete a stranger's first row)",
      async (_n, call) => {
        const mongoFn = jest.fn().mockResolvedValue({ file_id: 'STRANGER' });
        expect(await call(mongoFn)).toBeNull();
        expect(mongoFn).not.toHaveBeenCalled();
        expect(callConsoleFileRecordsProxy).not.toHaveBeenCalled();
      },
    );

    it('deleteFiles([undefined]) / deleteFiles([]) → {deletedCount: 0}, Mongo NEVER called', async () => {
      const mongoFn = jest.fn().mockResolvedValue({ deletedCount: 99 });
      expect(await bind('deleteFiles', mongoFn)([undefined, ''], undefined)).toEqual({
        deletedCount: 0,
      });
      expect(await bind('deleteFiles', mongoFn)([], undefined)).toEqual({ deletedCount: 0 });
      expect(mongoFn).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('F7 — the WRITE half is sovereign-first by id too', () => {
    it("process.js:314 shape deleteFiles(ids) with NO user: the owner's sovereign rows ARE deleted; only not-mine ids go to Mongo (NEUTER: `if (!user) return mongoFn(...)` → no DELETE proxy call → RED)", async () => {
      callConsoleFileRecordsProxy
        .mockResolvedValueOnce({ items: [item('own-1'), item('own-2')] })
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined);
      const mongoFn = jest.fn().mockResolvedValueOnce({ deletedCount: 1 });

      const result = await bind('deleteFiles', mongoFn)(['own-1', 'own-2', 'legacy-1'], undefined);

      expect(callConsoleFileRecordsProxy).toHaveBeenCalledWith({
        method: 'DELETE',
        path: 'own-1',
        token: 'tok',
      });
      expect(callConsoleFileRecordsProxy).toHaveBeenCalledWith({
        method: 'DELETE',
        path: 'own-2',
        token: 'tok',
      });
      expect(mongoFn).toHaveBeenCalledWith(['legacy-1'], undefined);
      expect(result).toEqual({ deletedCount: 3 });
    });

    it("deleteFiles(ids) where every id is the owner's: sovereign rows deleted, Mongo NEVER called", async () => {
      callConsoleFileRecordsProxy
        .mockResolvedValueOnce({ items: [item('own-1')] })
        .mockResolvedValueOnce(undefined);
      const mongoFn = jest.fn();
      expect(await bind('deleteFiles', mongoFn)(['own-1'], undefined)).toEqual({ deletedCount: 1 });
      expect(mongoFn).not.toHaveBeenCalled();
    });

    it('deleteFiles(null, user) — account deletion — sweeps BOTH stores and sums the counts', async () => {
      callConsoleFileRecordsProxy
        .mockResolvedValueOnce({ items: [item('a'), item('b')], next_cursor: null }) // listOwn
        .mockResolvedValueOnce({ items: [item('a'), item('b')] }) // batch-get resolve
        .mockResolvedValueOnce(undefined) // DELETE a
        .mockResolvedValueOnce(undefined); // DELETE b
      const mongoFn = jest.fn().mockResolvedValueOnce({ deletedCount: 1 });
      const result = await bind('deleteFiles', mongoFn)(null, 'u1');
      expect(result).toEqual({ deletedCount: 3 });
      expect(mongoFn).toHaveBeenCalledWith(null, 'u1');
      expect(callConsoleFileRecordsProxy).toHaveBeenCalledWith({
        method: 'DELETE',
        path: 'a',
        token: 'tok',
      });
      expect(callConsoleFileRecordsProxy).toHaveBeenCalledWith({
        method: 'DELETE',
        path: 'b',
        token: 'tok',
      });
    });

    it('deleteFile(file_id) — sovereign-first; found → DELETE + the deleted record; missing → Mongo', async () => {
      callConsoleFileRecordsProxy
        .mockResolvedValueOnce(item('mine'))
        .mockResolvedValueOnce(undefined);
      const mongoFn = jest.fn();
      const deleted = await bind('deleteFile', mongoFn)('mine');
      expect(deleted.file_id).toBe('mine');
      expect(callConsoleFileRecordsProxy).toHaveBeenCalledWith({
        method: 'DELETE',
        path: 'mine',
        token: 'tok',
      });
      expect(mongoFn).not.toHaveBeenCalled();

      callConsoleFileRecordsProxy.mockRejectedValueOnce(notFound());
      const legacy = jest.fn().mockResolvedValueOnce({ file_id: 'legacy' });
      expect(await bind('deleteFile', legacy)('legacy')).toEqual({ file_id: 'legacy' });
    });

    it('updateFileUsage({file_id}) with NO user (NEUTER: `if (!data.user) return mongoFn` → RED): sovereign-first — usage +inc, temp_file_id cleared, existing fields preserved', async () => {
      callConsoleFileRecordsProxy
        .mockResolvedValueOnce(item('mine', { usage: { count: 4 } }))
        .mockResolvedValueOnce(item('mine', { usage: { count: 6 }, temp_file_id: undefined }));
      const mongoFn = jest.fn();
      const result = await bind('updateFileUsage', mongoFn)({ file_id: 'mine', inc: 2 });
      expect(result.usage).toBe(6);
      const body = callConsoleFileRecordsProxy.mock.calls[1][0].body;
      expect(body.usage).toEqual({ count: 6 });
      expect(body.temp_file_id).toBeUndefined();
      expect(body.filename).toBe('mine.txt');
      expect(body.metadata.text).toBe('text-of-mine');
      expect(mongoFn).not.toHaveBeenCalled();
    });

    it('updateFileUsage for a not-mine/legacy id falls through to Mongo with the ORIGINAL data', async () => {
      callConsoleFileRecordsProxy.mockRejectedValueOnce(notFound());
      const mongoFn = jest.fn().mockResolvedValueOnce({ file_id: 'legacy', usage: 2 });
      const data = { file_id: 'legacy', user: 'u1' };
      expect(await bind('updateFileUsage', mongoFn)(data)).toEqual({ file_id: 'legacy', usage: 2 });
      expect(mongoFn).toHaveBeenCalledWith(data);
    });

    it('updateFilesUsage with NO options.user (NEUTER: `if (!opts.user) return mongoFn` → RED): dedupes ids, each sovereign-first, per-id fallback = the raw SINGULAR updateFileUsage, nulls dropped', async () => {
      callConsoleFileRecordsProxy
        .mockResolvedValueOnce(item('a')) // GET a
        .mockRejectedValueOnce(notFound()) // GET b
        .mockResolvedValueOnce(item('a', { usage: { count: 2 } })); // POST a
      const rawBatch = jest.fn();
      const rawSingular = jest.fn().mockResolvedValueOnce(null);
      const result = await bind('updateFilesUsage', rawBatch, { updateFileUsage: rawSingular })(
        [{ file_id: 'a' }, { file_id: 'a' }],
        ['b'],
        {},
      );
      expect(result.map((f) => f.file_id)).toEqual(['a']);
      expect(rawSingular).toHaveBeenCalledWith({
        file_id: 'b',
        user: undefined,
        tenantId: undefined,
      });
      expect(rawBatch).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('F3 — the owner is request-derived, never caller- or mapping-supplied; and it is what fileAccess/S3 compare against', () => {
    it("inside a request, every served record has user = req.user.id (the ALS subject) and user_sub = the store's value", async () => {
      callConsoleFileRecordsProxy.mockResolvedValueOnce({ items: [item('mine')] });
      const [file] = await runWithRequestAccessToken({ accessToken: 'tok', sub: 'lc-user-1' }, () =>
        bind('getFiles', jest.fn())({ file_id: 'mine', user: 'attacker' }, null, null),
      );
      expect(file).toBeUndefined(); // attacker-named owner ≠ the caller: post-filter excludes; nothing leaks
    });

    it('a served own record carries the request subject as `user` (what fileAccess and deleteFileFromS3 compare) and the Keycloak sub as `user_sub`', async () => {
      callConsoleFileRecordsProxy.mockResolvedValueOnce({ items: [item('mine')] });
      const [file] = await runWithRequestAccessToken({ accessToken: 'tok', sub: 'lc-user-1' }, () =>
        bind('getFiles', jest.fn())({ file_id: 'mine' }, null, null),
      );
      expect(file.user).toBe('lc-user-1');
      expect(file.user_sub).toBe('kc-sub-owner');
      expect(file.user.toString()).toBe('lc-user-1');
    });

    it("createFile never sends a caller-supplied owner; the returned record's owner is the request subject", async () => {
      callConsoleFileRecordsProxy.mockResolvedValueOnce(item('new'));
      const created = await runWithRequestAccessToken(
        { accessToken: 'tok', sub: 'lc-user-1' },
        () =>
          bind('createFile')(
            { file_id: 'new', filename: 'n.txt', user: 'attacker', user_sub: 'attacker' },
            false,
          ),
      );
      const body = callConsoleFileRecordsProxy.mock.calls[0][0].body;
      expect('user' in body).toBe(false);
      expect('user_sub' in body).toBe(false);
      expect(created.user).toBe('lc-user-1');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('writes — fail-closed, clobber-guarded, CAS deferred', () => {
    it('createFile requires data.file_id (400) and is sovereign-ONLY (no Mongo function is ever consulted)', async () => {
      await expect(bind('createFile')({}, false)).rejects.toMatchObject({ status: 400 });
      await expect(bind('createFile')(undefined, false)).rejects.toMatchObject({ status: 400 });
      expect(callConsoleFileRecordsProxy).not.toHaveBeenCalled();
    });

    it('every wired write with NO token (no ALS) rejects 401 before any hop or fallback', async () => {
      const mongoFn = jest.fn();
      const noTok = (name) =>
        SOVEREIGN_METHOD_BINDERS[name](undefined, mongoFn, { updateFileUsage: mongoFn });
      await expect(noTok('createFile')({ file_id: 'x' })).rejects.toBeInstanceOf(
        MissingAccessTokenError,
      );
      await expect(noTok('updateFile')({ file_id: 'x' })).rejects.toBeInstanceOf(
        MissingAccessTokenError,
      );
      await expect(noTok('deleteFile')('x')).rejects.toBeInstanceOf(MissingAccessTokenError);
      await expect(noTok('deleteFiles')(['x'])).rejects.toBeInstanceOf(MissingAccessTokenError);
      await expect(noTok('deleteFiles')(null, 'u1')).rejects.toBeInstanceOf(
        MissingAccessTokenError,
      );
      await expect(noTok('updateFileUsage')({ file_id: 'x' })).rejects.toBeInstanceOf(
        MissingAccessTokenError,
      );
      await expect(noTok('getFiles')({ file_id: 'x' })).rejects.toBeInstanceOf(
        MissingAccessTokenError,
      );
      expect(mongoFn).not.toHaveBeenCalled();
      expect(callConsoleFileRecordsProxy).not.toHaveBeenCalled();
    });

    it('updateFile (plain) fetches-then-merges: fields the caller did not mention are PRESERVED', async () => {
      callConsoleFileRecordsProxy
        .mockResolvedValueOnce(item('mine', { bytes: 77, object_key: 'k' }))
        .mockResolvedValueOnce(item('mine'));
      const mongoFn = jest.fn();
      await bind('updateFile', mongoFn)(
        { file_id: 'mine', status: 'failed', previewError: 'orphaned' },
        undefined,
      );
      const body = callConsoleFileRecordsProxy.mock.calls[1][0].body;
      expect(body).toMatchObject({
        file_id: 'mine',
        filename: 'mine.txt',
        bytes: 77,
        object_key: 'k',
        metadata: expect.objectContaining({
          text: 'text-of-mine',
          status: 'failed',
          previewError: 'orphaned',
        }),
      });
      expect(mongoFn).not.toHaveBeenCalled();
    });

    it('updateFile (plain) for a not-mine/legacy id falls through to Mongo with the ORIGINAL arguments', async () => {
      callConsoleFileRecordsProxy.mockRejectedValueOnce(notFound());
      const mongoFn = jest.fn().mockResolvedValueOnce({ file_id: 'legacy' });
      const data = { file_id: 'legacy', status: 'ready' };
      expect(await bind('updateFile', mongoFn)(data, undefined)).toEqual({ file_id: 'legacy' });
      expect(mongoFn).toHaveBeenCalledWith(data, undefined);
    });

    it('updateFile with an extraFilter (the deferred-preview compare-and-swap) is DEFERRED to Mongo unchanged (DISCLOSED CONSEQUENCE §5)', async () => {
      const mongoFn = jest.fn().mockResolvedValueOnce(null);
      const data = { file_id: 'mine', status: 'failed' };
      const cas = { status: 'pending', updatedAt: new Date(0) };
      expect(await bind('updateFile', mongoFn)(data, cas)).toBeNull();
      expect(mongoFn).toHaveBeenCalledWith(data, cas);
      expect(callConsoleFileRecordsProxy).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('F8 — the {user} own-list ceiling is declared and LOGGED when hit', () => {
    it('declares 100 x 50 (5000 files/user) and the base warns naming the files domain when the ceiling is reached', async () => {
      expect(LIST_PAGE_SIZE * LIST_MAX_PAGES).toBe(5000);
      callConsoleFileRecordsProxy.mockResolvedValue({ items: [item('x')], next_cursor: 'more' });
      const result = await runWithRequestAccessToken({ accessToken: 'tok', sub: 'u1' }, () =>
        bind('getFiles', jest.fn())({ user: 'u1' }, null, null),
      );
      expect(result).toHaveLength(LIST_MAX_PAGES);
      expect(callConsoleFileRecordsProxy).toHaveBeenCalledTimes(LIST_MAX_PAGES);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          '[AuditTraceSovereignAdapter:files] listOwn hit the disclosed ceiling',
        ),
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('defensive arms — null/undefined arguments never reach the store or Mongo with a stripped shape', () => {
    it('updateFile(undefined) / updateFileUsage(undefined) / createFile(null) — no id → null / 400, nothing called', async () => {
      const mongoFn = jest.fn();
      expect(await bind('updateFile', mongoFn)(undefined, undefined)).toBeNull();
      expect(await bind('updateFileUsage', mongoFn)(undefined)).toBeNull();
      await expect(bind('createFile', mongoFn)(null, true)).rejects.toMatchObject({ status: 400 });
      expect(mongoFn).not.toHaveBeenCalled();
      expect(callConsoleFileRecordsProxy).not.toHaveBeenCalled();
    });

    it('updateFileUsage defaults inc to 1 when absent', async () => {
      callConsoleFileRecordsProxy
        .mockResolvedValueOnce(item('mine', { usage: { count: 4 } }))
        .mockResolvedValueOnce(item('mine', { usage: { count: 5 } }));
      await bind('updateFileUsage', jest.fn())({ file_id: 'mine' });
      expect(callConsoleFileRecordsProxy.mock.calls[1][0].body.usage).toEqual({ count: 5 });
    });

    it('updateFilesUsage tolerates undefined files/fileIds/options and null entries; no ids → [] with nothing called', async () => {
      const rawBatch = jest.fn();
      const rawSingular = jest.fn();
      expect(
        await bind('updateFilesUsage', rawBatch, { updateFileUsage: rawSingular })(
          undefined,
          undefined,
          undefined,
        ),
      ).toEqual([]);
      expect(
        await bind('updateFilesUsage', rawBatch, { updateFileUsage: rawSingular })(
          [null, {}, { file_id: '' }],
          [undefined],
          null,
        ),
      ).toEqual([]);
      expect(rawBatch).not.toHaveBeenCalled();
      expect(rawSingular).not.toHaveBeenCalled();
      expect(callConsoleFileRecordsProxy).not.toHaveBeenCalled();
    });

    it('deleteFiles(null, user) counts 0 for a Mongo result with no deletedCount, and skips own rows lacking a usable file_id', async () => {
      callConsoleFileRecordsProxy
        .mockResolvedValueOnce({ items: [item('a'), { user_sub: 'x' }], next_cursor: null }) // listOwn
        .mockResolvedValueOnce({ items: [item('a')] }) // batch-get
        .mockResolvedValueOnce(undefined); // DELETE a
      const mongoFn = jest.fn().mockResolvedValueOnce(undefined);
      expect(await bind('deleteFiles', mongoFn)(null, 'u1')).toEqual({ deletedCount: 1 });
      expect(callConsoleFileRecordsProxy).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'batch-get', body: { file_ids: ['a'] } }),
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe("F-A2 — deleteFiles(null, user) sweeps ONLY the request subject's own-list (NEUTER: drop the `user !== sub` check → the caller's rows are listed and DELETEd: RED)", () => {
    it("an admin-shaped call naming ANOTHER user: the caller's sovereign own-list is NOT listed, NOT deleted; Mongo runs for the named user only; count = Mongo's; warning logged", async () => {
      // Queue an own-list + DELETE so the leak WOULD be observable if the guard were absent.
      callConsoleFileRecordsProxy
        .mockResolvedValueOnce({ items: [item('admins-own')], next_cursor: null })
        .mockResolvedValueOnce({ items: [item('admins-own')] })
        .mockResolvedValueOnce(undefined);
      const mongoFn = jest.fn().mockResolvedValueOnce({ deletedCount: 4 });

      const result = await runWithRequestAccessToken({ accessToken: 'tok', sub: 'admin-1' }, () =>
        bind('deleteFiles', mongoFn)(null, 'victim-2'),
      );

      expect(result).toEqual({ deletedCount: 4 });
      expect(callConsoleFileRecordsProxy).not.toHaveBeenCalled();
      expect(callConsoleFileRecordsProxy).not.toHaveBeenCalledWith(
        expect.objectContaining({ method: 'DELETE' }),
      );
      expect(mongoFn).toHaveBeenCalledTimes(1);
      expect(mongoFn).toHaveBeenCalledWith(null, 'victim-2');
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('F-A2'));
    });

    it('the live self-deletion shape (user === req.user.id, UserController.js:454) still sweeps BOTH stores — the guard does not over-block', async () => {
      callConsoleFileRecordsProxy
        .mockResolvedValueOnce({ items: [item('mine')], next_cursor: null })
        .mockResolvedValueOnce({ items: [item('mine')] })
        .mockResolvedValueOnce(undefined);
      const mongoFn = jest.fn().mockResolvedValueOnce({ deletedCount: 1 });

      const result = await runWithRequestAccessToken({ accessToken: 'tok', sub: 'u1' }, () =>
        bind('deleteFiles', mongoFn)(null, 'u1'),
      );

      expect(result).toEqual({ deletedCount: 2 });
      expect(callConsoleFileRecordsProxy).toHaveBeenCalledWith({
        method: 'DELETE',
        path: 'mine',
        token: 'tok',
      });
      expect(mongoFn).toHaveBeenCalledWith(null, 'u1');
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('no token → MissingAccessTokenError BEFORE the subject check, nothing called (fail-closed order preserved)', async () => {
      const mongoFn = jest.fn();
      await expect(
        runWithRequestAccessToken({ sub: 'admin-1' }, () =>
          SOVEREIGN_METHOD_BINDERS.deleteFiles(undefined, mongoFn, {})(null, 'victim-2'),
        ),
      ).rejects.toBeInstanceOf(MissingAccessTokenError);
      expect(mongoFn).not.toHaveBeenCalled();
      expect(callConsoleFileRecordsProxy).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('F-A1 at the files level — the pre-wrapped ctx handles and the explicit Mongo-bound data', () => {
    it('process.js:1143 shape updateFileUsage({file_id, user, tenantId: undefined}) for a LEGACY row: the Mongo fallback IS reached with the same data minus the undefined key (single-tenant deployments keep working through the closed hatch)', async () => {
      callConsoleFileRecordsProxy.mockRejectedValueOnce(notFound());
      const mongoFn = jest.fn().mockResolvedValueOnce({ file_id: 'legacy', usage: 2 });
      const result = await bind(
        'updateFileUsage',
        mongoFn,
      )({
        file_id: 'legacy',
        user: 'u1',
        tenantId: undefined,
      });
      expect(result).toEqual({ file_id: 'legacy', usage: 2 });
      expect(mongoFn).toHaveBeenCalledTimes(1);
      expect(Object.keys(mongoFn.mock.calls[0][0])).toEqual(['file_id', 'user']);
      expect(mongoFn.mock.calls[0][0]).toEqual({ file_id: 'legacy', user: 'u1' });
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('the ctx.mongoFn the files domain receives is the GUARDED handle: a strippable filter handed to it directly never reaches the raw Mongo function', async () => {
      const mongoFn = jest
        .fn()
        .mockResolvedValue([{ file_id: 'ANOTHER-USERS-ROW', text: 'secret' }]);
      let handle;
      // Observe the ctx a real files impl is given, without changing the domain.
      const spy = jest
        .spyOn(filesAdapter.methods.getFiles, 'impl')
        .mockImplementation(function observe(_args, ctx) {
          handle = ctx.mongoFn;
          return [];
        });
      try {
        await bind('getFiles', mongoFn)({ file_id: 'x' }, null, {});
      } finally {
        spy.mockRestore();
      }
      expect(handle).not.toBe(mongoFn);
      expect(await handle({ _id: undefined }, null, {})).toEqual([]);
      expect(mongoFn).not.toHaveBeenCalled();
      const safe = { file_id: 'shared' };
      await handle(safe, null, {});
      expect(mongoFn.mock.calls[0][0]).toBe(safe);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('F-A3 — the own-list branch NEVER falls through to Mongo (disclosure accuracy)', () => {
    it('{user: <someone else>} (no id key) returns [] from the sovereign LIST endpoint and Mongo is NOT consulted — unlike the id-shaped branch; the docstring states it', async () => {
      callConsoleFileRecordsProxy.mockResolvedValueOnce({
        items: [item('mine')],
        next_cursor: null,
      });
      const mongoFn = jest.fn().mockResolvedValue([{ file_id: 'theirs', legacy: true }]);
      const result = await runWithRequestAccessToken({ accessToken: 'tok', sub: 'u1' }, () =>
        bind('getFiles', mongoFn)({ user: 'someone-else' }, null, {}),
      );
      expect(result).toEqual([]);
      expect(mongoFn).not.toHaveBeenCalled();
      expect(callConsoleFileRecordsProxy).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'GET', path: '' }),
      );
      const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
      expect(src).toMatch(/OWN-LIST shape[\s\S]*NEVER falls through to Mongo/);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('residual + errors', () => {
    it('a residual getFiles shape (no id, no owner) defers to Mongo UNCHANGED (DISCLOSED CONSEQUENCE §6)', async () => {
      const mongoFn = jest.fn().mockResolvedValueOnce([]);
      const filter = { expiredAt: { $ne: null } };
      await bind('getFiles', mongoFn)(filter, { expiredAt: 1 }, null);
      expect(mongoFn).toHaveBeenCalledWith(filter, { expiredAt: 1 }, null);
      expect(callConsoleFileRecordsProxy).not.toHaveBeenCalled();
    });

    it('a non-404 store error propagates unchanged — never a silent Mongo fallback', async () => {
      callConsoleFileRecordsProxy.mockRejectedValueOnce(new SovereignMemoryError('down', 502));
      const mongoFn = jest.fn();
      await expect(bind('deleteFile', mongoFn)('mine')).rejects.toMatchObject({ status: 502 });
      expect(mongoFn).not.toHaveBeenCalled();
    });
  });
});
