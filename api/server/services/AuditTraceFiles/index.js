/**
 * The sovereign-files adapter — the REFERENCE ADOPTER of
 * `AuditTraceSovereignAdapter` (MongoDB-elimination EPIC, WU-B of
 * `2026-09-13-SPEC-sovereign-store-and-adapter-abstractions`). The
 * `~/models` file methods (`packages/data-schemas/src/methods/file.ts`)
 * LibreChat calls for persistence, backed by HTTP calls to the BFF
 * `/console/file-records/*` proxy instead of Mongo, gated behind
 * `AUDITTRACE_MEMORY_BACKEND=sovereign` (`../AuditTraceMemory/config`).
 *
 * **This module is THIN by design.** It declares WHAT the files domain
 * is — the BFF client, the id field (+ its `_id` alias), the field
 * mapping, the batch-get route, the list ceiling, and per method its
 * classification + a 1-to-6-line `impl` that composes the base's
 * primitives. It contains NO read-classification logic, NO
 * fall-through logic, NO owner stamping, NO undefined-key guard, NO
 * clobber-merge — every one of those lives in `../AuditTraceSovereignAdapter`
 * and is proven there ONCE. Three consecutive hand-written files shims
 * were REJECTED (`lesson-sovereign-adapter-read-discipline-20260913`):
 * v1 threw on owner reads; v2 split-brained owner reads on a `user`-key
 * predicate; the v2 fix-round leaked another user's text via
 * `{_id: undefined}` (F6) and orphaned the sovereign row on own delete
 * (F7). Each is now structurally impossible here because this module
 * cannot express them: it has no hand-rolled path to Mongo at all —
 * `ctx.mongoFn` is only ever reached THROUGH a base primitive's
 * `fallback`, after the base has resolved the caller's own rows first.
 *
 * ============================================================
 * HOW EACH PRIOR REJECT IS CLOSED (regression-tested in `index.spec.js`)
 * ============================================================
 *  - **v1 (over-strict throw):** `getFiles` → `readByFilter`, which
 *    SERVES every id-shaped and own-list shape (image-tools `{user,
 *    file_id:{$in}, height:{$exists}, width:{$exists}}`, by-id-set,
 *    bare `{user}`) and defers the residual to Mongo; it never throws
 *    on a shape.
 *  - **v2 (owner split-brain):** a bare `{file_id}` / `{file_id:{$in}}`
 *    with NO `user` key (`fileAccess.js:102`, `files.js:207` DELETE,
 *    `files.js:133` agent files, `share.js`, `fileSearch.js`, …) is
 *    id-shaped → sovereign-first under the token's RLS scope → the
 *    OWNER's row is served. A genuine sharee finds nothing there and
 *    falls to Mongo for those ids only (the disclosed boundary below).
 *  - **F3 (caller-supplied owner):** `mapping.js` emits NO `user`; the
 *    base stamps `user` = the authenticated request's subject
 *    (`req.user.id` via the ONE ALS) and `user_sub` = the store's
 *    value. This is also what makes `fileAccess`'s owner test and
 *    `deleteFileFromS3`'s owner fail-close hold for a sovereign row —
 *    both compare against LibreChat's user id, not the Keycloak `sub`
 *    (see the base's invariant 6 for why `user_sub` verbatim would have
 *    failed both live).
 *  - **F6 (undefined-key leak):** `files.js:586`'s `{_id: file._id}`
 *    re-fetch: `apiToFile` now emits `_id = file_id` and the base treats
 *    `_id` as an id ALIAS, so the re-fetch is an own-scoped sovereign
 *    read served WITH `text` (invariant 5); AND any `{_id: undefined}`
 *    that could still arise is short-circuited to `[]` by the base
 *    (invariant 4) — Mongo is never consulted with a strippable filter.
 *  - **F7 (delete WRITE half):** `deleteFiles(ids)` with NO `user`
 *    (`services/Files/process.js:314`, the SOLE live caller, owner-only
 *    by construction) → `deleteByIds` → the owner's sovereign rows ARE
 *    deleted; missing ids go to Mongo. `updateFileUsage`/
 *    `updateFilesUsage` likewise no longer gate on `data.user`/
 *    `options.user` — sovereign-first by id, always.
 *  - **F8 (disclosed truncation):** the `{user}` list path pages via
 *    the base's `listOwn` with the declared ceiling below
 *    (`LIST_PAGE_SIZE * LIST_MAX_PAGES` = 5000 files/user); hitting it
 *    LOGS a warning. DISCLOSED CONSEQUENCE §4 states it.
 *
 * ============================================================
 * GROUND-THE-SURFACE ENUMERATION — `createFileMethods` exports EXACTLY
 * 17 functions. 8 wired + 9 disclosed-unwired = 17.
 * ============================================================
 * **WIRED (chokepointed via `SOVEREIGN_METHOD_BINDERS`) — 8:**
 * `findFileById` (read-by-id), `getFiles` (read-by-filter), `createFile`
 * (write, sovereign-only), `updateFile` (write-by-id; the `extraFilter`
 * compare-and-swap shape is DEFERRED — no sovereign CAS primitive),
 * `updateFileUsage` / `updateFilesUsage` (write-by-id, per id),
 * `deleteFile` (write-by-id), `deleteFiles` (write-by-ids; the
 * `(null, user)` account-deletion shape sweeps BOTH stores).
 *
 * **DISCLOSED-UNWIRED — 9, each unconditionally Mongo regardless of the
 * flag, for the reason given:**
 *  - `getExpiredFiles`, `sweepOrphanedPreviews` — no-token background
 *    reapers with no owner scope; the sovereign schema has no TTL /
 *    preview-status column to sweep (LESSON 4's one disclosed category).
 *  - `batchUpdateFiles` — the S3-signed-URL refresh; per-item shape
 *    carries no owner; see DISCLOSED CONSEQUENCE §3.
 *  - `extendFilesTTL` — a Mongo-only `$lt`-guarded TTL widening; the
 *    sovereign schema tracks no TTL (a store-capability gap).
 *  - `deleteFileByFilter` — deletes by `{user, filepath}`; the store's
 *    only delete primitive is by `file_id` and `filepath` is not a
 *    first-class column (a store-capability gap; the sovereign row for
 *    a replaced avatar is not cleaned up by this call — disclosed).
 *  - `getToolFilesByIds`, `getCodeGeneratedFiles`, `getUserCodeFiles` —
 *    call the LOCAL `getFiles` closure inside `createFileMethods`, not
 *    the exported, chokepoint-wrapped one; unreachable by construction.
 *  - `claimCodeFile` — an ATOMIC `$setOnInsert` upsert the sovereign
 *    read-then-write upsert cannot reproduce without re-introducing the
 *    duplicate race it exists to close. Consequence: a code-interpreter
 *    output claimed into Mongo is invisible to the sovereign own-list.
 *
 * ============================================================
 * DISCLOSED CONSEQUENCES (deploy-acceptance — stated, not hidden)
 * ============================================================
 *  1. **Explicit-sharing degraded while the flag is ON, until its own
 *     WU — scoped to genuinely-not-mine reads only.** The OWNER's own
 *     preview/download/agent-files/delete WORK (sovereign-first by id,
 *     whatever the filter's owner key). ONLY a sharee's cross-user read
 *     (`share.js`, an agent-tool-resource lookup for another user's
 *     file, a non-owner's agent-shared preview) falls to Mongo and,
 *     once the owner's metadata is 100% sovereign, finds nothing. Do NOT
 *     flip `AUDITTRACE_MEMORY_BACKEND=sovereign` for files in production
 *     until the explicit-sharing WU lands, or accept this interim
 *     sharee-only degradation.
 *  2. **TTL/retention is not ported.** A file created under the flag
 *     has no enforced upload-window expiry in the sovereign store.
 *  3. **`batchUpdateFiles` stays Mongo-native**, so a sovereign-served
 *     file's `filepath` is the last signed URL known at write time.
 *  4. **The `{user}` own-list is bounded at 5000 files/user** (the
 *     base's declared ceiling; a warning is logged when hit).
 *  5. **`updateFile` with an `extraFilter` (the deferred-preview CAS)
 *     is Mongo-native**: for a sovereign-only row it returns `null`
 *     (the same "conditional filter excluded it" contract) — the
 *     preview-status CAS does not advance a sovereign row.
 *  6. **A residual `getFiles` shape naming neither `file_id`/`_id` nor
 *     `user` (none exists at a live chokepointed site today) defers to
 *     Mongo unchanged and cannot see sovereign-only rows.**
 *
 * **S3 isolation (verified, unchanged):** `getS3Key` namespaces every
 * object key by the uploading `req.user.id`; `deleteFileFromS3` parses
 * the key back and THROWS on an owner mismatch before deleting. This WU
 * touches metadata only; the byte path is not in the diff.
 *
 * **Chokepoint:** this module exports ONLY its adapter + binders. The
 * sovereign-vs-Mongo decision stays in
 * `AuditTraceConversations/index.js::wrapModelMethods` (ONE call site in
 * `api/models/index.js`, ONE `AsyncLocalStorage`), which merges
 * `SOVEREIGN_METHOD_BINDERS` below into `ALL_SOVEREIGN_METHOD_BINDERS`.
 */

const { AuditTraceSovereignAdapter } = require('../AuditTraceSovereignAdapter');
const { SovereignMemoryError } = require('../AuditTraceMemory/errors');
const { callConsoleFileRecordsProxy } = require('./client');
const { fileUpsertBody, apiToFile } = require('./mapping');

/** DISCLOSED CONSEQUENCE §4: 100 x 50 = 5000 files/user own-list ceiling. */
const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 50;

/** @param {unknown} v @returns {v is string} */
const isId = (v) => typeof v === 'string' && v.length > 0;

/**
 * The usage-increment merge (Mongo's `$inc: {usage}` + `$unset:
 * {temp_file_id}`) expressed as a fetch-then-merge hook for the base's
 * `updateById`.
 *
 * @param {number} inc
 * @returns {(existing: Record<string, unknown>) => Record<string, unknown>}
 */
const usageMerge = (inc) => (existing) => ({
  ...existing,
  usage: (typeof existing.usage === 'number' ? existing.usage : 0) + inc,
  temp_file_id: undefined,
});

class AuditTraceFilesAdapter extends AuditTraceSovereignAdapter {
  constructor() {
    super({
      domain: 'files',
      callProxy: callConsoleFileRecordsProxy,
      idField: 'file_id',
      idAliases: ['_id'],
      ownerField: 'user',
      fromApi: apiToFile,
      toApiBody: fileUpsertBody,
      batchGet: { path: 'batch-get', bodyKey: 'file_ids' },
      list: { pageSize: LIST_PAGE_SIZE, maxPages: LIST_MAX_PAGES },
      methods: {
        // Mongo: findFileById(file_id, options?) — read-by-id.
        findFileById: {
          kind: 'read',
          arity: 2,
          impl([fileId, options], ctx) {
            return this.readOne(fileId, { ...ctx, fallback: () => ctx.mongoFn(fileId, options) });
          },
        },
        // Mongo: getFiles(filter, sortOptions?, selectFields?) — read-by-filter.
        // `sortOptions`/`selectFields` are accepted for signature parity:
        // the sovereign result is newest-first and always the full record.
        getFiles: {
          kind: 'read',
          arity: 3,
          impl([filter, sortOptions, selectFields], ctx) {
            return this.readByFilter(filter, {
              ...ctx,
              fallback: (f) => ctx.mongoFn(f, sortOptions, selectFields),
            });
          },
        },
        // Mongo: createFile(data, disableTTL?) — sovereign-ONLY write.
        // `disableTTL` has no sovereign effect (DISCLOSED CONSEQUENCE §2).
        createFile: {
          kind: 'write',
          arity: 2,
          impl([data], ctx) {
            const src = data || {};
            if (!isId(src.file_id)) {
              throw new SovereignMemoryError(
                'createFile requires data.file_id to route to the sovereign store',
                400,
              );
            }
            return this.create(src.file_id, src, ctx);
          },
        },
        // Mongo: updateFile(data, extraFilter?) — write-by-id; the CAS
        // shape is deferred (DISCLOSED CONSEQUENCE §5).
        updateFile: {
          kind: 'write',
          arity: 2,
          emptyResult: null,
          impl([data, extraFilter], ctx) {
            const src = data || {};
            if (!isId(src.file_id)) {
              return null;
            }
            if (extraFilter) {
              return this.deferToMongo(ctx, [data, extraFilter]);
            }
            return this.updateById(src.file_id, src, {
              ...ctx,
              fallback: () => ctx.mongoFn(data, extraFilter),
            });
          },
        },
        // Mongo: updateFileUsage({file_id, inc?, user?, tenantId?}) —
        // write-by-id. NO `data.user` gate (F7): sovereign-first by id.
        updateFileUsage: {
          kind: 'write',
          arity: 1,
          impl([data], ctx) {
            const src = data || {};
            const inc = typeof src.inc === 'number' ? src.inc : 1;
            return this.updateById(
              src.file_id,
              {},
              {
                ...ctx,
                merge: usageMerge(inc),
                fallback: () => ctx.mongoFn(data),
              },
            );
          },
        },
        // Mongo: updateFilesUsage(files, fileIds?, options?) — per deduped
        // id, each through THIS domain's `updateFileUsage` discipline, with
        // the raw SINGULAR Mongo method as that id's fallback. NO
        // `options.user` gate (F7).
        updateFilesUsage: {
          kind: 'write',
          arity: 3,
          async impl([files, fileIds, options], ctx) {
            const opts = options || {};
            const ids = [
              ...new Set(
                [...(files || []).map((f) => f && f.file_id), ...(fileIds || [])].filter(isId),
              ),
            ];
            const rawSingular = ctx.mongoMethods.updateFileUsage;
            const results = await Promise.all(
              ids.map((file_id) =>
                this.methods.updateFileUsage.impl.call(
                  this,
                  [{ file_id, user: opts.user, tenantId: opts.tenantId }],
                  { ...ctx, mongoFn: rawSingular },
                ),
              ),
            );
            return results.filter((r) => r != null);
          },
        },
        // Mongo: deleteFile(file_id) — write-by-id.
        deleteFile: {
          kind: 'write',
          arity: 1,
          impl([fileId], ctx) {
            return this.deleteById(fileId, { ...ctx, fallback: () => ctx.mongoFn(fileId) });
          },
        },
        // Mongo: deleteFiles(file_ids, user?) — write-by-ids (F7). The
        // `(null, user)` "delete all mine" shape (`UserController.js`'s
        // account deletion) sweeps BOTH stores: every sovereign own row
        // AND Mongo's own `{user}` deleteMany — belt-and-suspenders on a
        // retention-sensitive path.
        deleteFiles: {
          kind: 'write',
          arity: 2,
          async impl([fileIds, user], ctx) {
            if (!user) {
              return this.deleteByIds(fileIds, {
                ...ctx,
                fallback: (missing) => ctx.mongoFn(missing, undefined),
              });
            }
            const token = this.requireToken(ctx.token);
            const own = await this.listOwn(token);
            const ownIds = own.map((item) => item.file_id).filter(isId);
            const sovereign = await this.deleteByIds(ownIds, {
              token,
              fallback: async () => ({ deletedCount: 0 }),
            });
            const mongoResult = await ctx.mongoFn(null, user);
            const mongoCount =
              mongoResult && typeof mongoResult.deletedCount === 'number'
                ? mongoResult.deletedCount
                : 0;
            return { deletedCount: sovereign.deletedCount + mongoCount };
          },
        },
      },
    });
  }
}

const filesAdapter = new AuditTraceFilesAdapter();

/**
 * The files domain's contribution to the ONE chokepoint — built by the
 * base (fixed arities, `(token, mongoFn, mongoMethods)` signature), merged
 * into `ALL_SOVEREIGN_METHOD_BINDERS` by `AuditTraceConversations/index.js`.
 */
const SOVEREIGN_METHOD_BINDERS = filesAdapter.buildBinders();

module.exports = {
  AuditTraceFilesAdapter,
  filesAdapter,
  SOVEREIGN_METHOD_BINDERS,
  LIST_PAGE_SIZE,
  LIST_MAX_PAGES,
};
