/**
 * THE WIRE PROBE (2026-09-17 review reject / ADDENDUM G —
 * `2026-09-17-SPEC-ADDENDUM-G-derive-the-surface-table-from-the-WIRE-not-
 * from-reading.md`, fix round 3).
 *
 * **What this file is, and why it exists as a SEPARATE spec.** Three
 * rounds built the interpolation-surface table by READING `index.js` and
 * got it wrong in both directions each time (round 1: missed a PATH
 * surface; round 2: missed a BODY surface; round 3: missed a QUERY-STRING
 * surface entirely, on THREE different methods). The reviewer's own
 * throwaway probe found this by mocking ONLY `./client` (the transport
 * boundary), invoking every wired method with sentinel values, and
 * reading the captured `callProxy` arguments — never re-reading the
 * `impl` bodies. This file reproduces exactly that technique as a
 * COMMITTED, falsifiable test: **the table below is GENERATED from the
 * `it()`s' own `expect(capture()).toEqual([...])` assertions — remove or
 * shrink an interpolation site in `index.js` and the corresponding `it()`
 * goes RED on the missing/changed call; add a new one silently and the
 * `toHaveLength`/exact-array assertion in the same `it()` goes RED on the
 * extra call.** That is what makes this check CAPABLE OF FAILING
 * (ADDENDUM G R5) — a prose table asserted nowhere cannot.
 *
 * Mocks ONLY `./client` and the logger (`@librechat/data-schemas`) — the
 * base (`AuditTraceSovereignAdapter`), this domain's declaration
 * (`index.js`), and the shared `requestContext` ALS are REAL, unmocked
 * code, exactly like `index.spec.js`. Every sentinel value below
 * (`SENTINEL_TAG_*`, `SENTINEL_DESC_*`, `SENTINEL_CURSOR`) is chosen to be
 * unique and traceable through the capture so a reviewer can see exactly
 * which call produced which row without cross-referencing `index.js`.
 *
 * **Scope.** Every method `SOVEREIGN_METHOD_BINDERS` exports (the SIX
 * wired methods) is invoked at least once on its SOVEREIGN (non-deferred)
 * path — the path that reaches `callProxy` at all. A Mongo-deferred call
 * (`addToConversation` + `conversationId`, a rename, a `position` change,
 * a non-`{user}` filter shape) makes ZERO `callProxy` calls by
 * construction — there is no wire surface to capture — and those shapes
 * are already pinned behaviourally in `index.spec.js`; re-probing them
 * here would assert an empty array and add nothing. `updateTagsForConversation`
 * is DISCLOSED-UNWIRED (`index.js` §5): no binder exists for it at all,
 * so it is outside this chokepoint's `callProxy` surface by construction
 * and is not probed here either.
 *
 * ============================================================
 * THE GENERATED TABLE (one block per `it()` below; PATH / QUERY STRING /
 * JSON BODY named for every caller-supplied value that crosses the wire,
 * per ADDENDUM G point 3)
 * ============================================================
 *
 *   getConversationTags     GET  path:""  query:{limit:"100"}                              -> QUERY STRING
 *                           GET  path:""  query:{limit:"100", cursor:"SENTINEL_CURSOR"}      -> QUERY STRING
 *                                (page 2's `cursor` is the BFF's OWN `next_cursor` from
 *                                 page 1, echoed verbatim — a server-issued, caller-replayed
 *                                 value, not a value the caller invented)
 *
 *   createConversationTag   GET  path:"SENTINEL_TAG_1"                                      -> URL PATH
 *                                (readOne's idempotency pre-read; `src.tag` interpolated)
 *                           GET  path:""  query:{limit:"100"}                                -> QUERY STRING
 *                                (listOwn's maxPosition scan — THREE surfaces, not two;
 *                                 this is the row three prior rounds undercounted)
 *                           POST path:""  body:{tag:"SENTINEL_TAG_1",
 *                                               description:"SENTINEL_DESC_1",
 *                                               count:0, position:5, metadata:{}}            -> JSON BODY
 *                                (`this.create`; `tag` AND `description` are both
 *                                 caller-supplied values crossing in the body, not just `tag`)
 *
 *   updateConversationTag   GET  path:"SENTINEL_TAG_2"                                      -> URL PATH
 *                                (`this.updateById`'s `fetchRaw` pre-read; the id)
 *                           POST path:""  body:{tag:"SENTINEL_TAG_2",
 *                                               description:"SENTINEL_DESC_2",
 *                                               count:3, position:2, metadata:{}}            -> JSON BODY
 *                                (`this.updateById`'s upsert; `this.updateById` composes
 *                                 BOTH surfaces — it is not a path-only primitive)
 *
 *   deleteConversationTag   GET    path:"SENTINEL_TAG_3"                                    -> URL PATH
 *                           DELETE path:"SENTINEL_TAG_3"                                    -> URL PATH
 *                                (`this.deleteById`'s `fetchRaw` pre-read then the delete;
 *                                 no query/body surface on this method)
 *
 *   deleteConversationTags  GET    path:""  query:{limit:"100"}                             -> QUERY STRING
 *                                (`this.listOwn` — the caller's OWN tag ids)
 *                           GET    path:"SENTINEL_TAG_A"                                    -> URL PATH
 *                           GET    path:"SENTINEL_TAG_B"                                    -> URL PATH
 *                                (`resolveByIds`'s per-id fan-out — this domain has no
 *                                 `batchGet` route)
 *                           DELETE path:"SENTINEL_TAG_A"                                    -> URL PATH
 *                           DELETE path:"SENTINEL_TAG_B"                                    -> URL PATH
 *                                (`deleteByIds`'s per-id delete; no body/query surface)
 *
 *   bulkIncrementTagCounts  GET  path:"SENTINEL_TAG_X"                                      -> URL PATH
 *                                (`this.updateById`'s `fetchRaw` pre-read; the caller's
 *                                 own tag list, filtered/deduped, is the id source)
 *                           POST path:""  body:{tag:"SENTINEL_TAG_X", description:"d",
 *                                               count:3, position:1, metadata:{}}            -> JSON BODY
 *                                (same `this.updateById` composition as `updateConversationTag`)
 *
 * ============================================================
 * PER-ROW SELF-CHECK (ADDENDUM G R5 — a row cleared with no captured call
 * behind it is not checked; every row above is checked against the named
 * `it()`, by exact-array `toEqual`, so an omission OR an addition fails it)
 * ============================================================
 *  - getConversationTags rows  -> checked against "own-list, then the
 *    NEXT PAGE echoes the BFF's next_cursor" below (2 calls asserted).
 *  - createConversationTag rows (all THREE) -> checked against "THREE
 *    wire calls in sequence" below (3 calls asserted, one `toEqual` on
 *    the whole captured array — cannot silently pass with only 2).
 *  - updateConversationTag rows (both) -> checked against "TWO wire
 *    calls: path then body" below.
 *  - deleteConversationTag rows (both) -> checked against "TWO wire
 *    calls: path then path" below.
 *  - deleteConversationTags rows (all FIVE) -> checked against "listOwn,
 *    then a fetchRaw+DELETE pair per owned tag" below (`toHaveLength(5)`
 *    guards against a batch-get shortcut silently replacing the fan-out).
 *  - bulkIncrementTagCounts rows (both) -> checked against "TWO wire
 *    calls: path then body" below.
 *
 * ============================================================
 * TWO DISCLOSURES REQUIRED BY THIS ROUND (ADDENDUM G, "Also required")
 * ============================================================
 *  A. **`getConversationTags(user)` DISCARDS its caller-supplied `user`
 *     on the sovereign path.** `classifyFilter({user}, ...)` only checks
 *     that `user` is a non-empty STRING to select the `own-list` shape
 *     (`AuditTraceSovereignAdapter/filters.js`'s own docstring: "this is
 *     NOT owner-key scoping — RLS scopes by the token regardless"); the
 *     actual rows served come from `this.listOwn(token)`, scoped by the
 *     CALLER'S OWN bearer token, never by the string value of `user`.
 *     **Decision: ACCEPTED, not a bug** — this is the base's declared,
 *     documented invariant (every other migrated domain relies on the
 *     same own-list shape), and it is fail-SAFE, not fail-open: a caller
 *     who names another user's id receives their OWN tags, never the
 *     named stranger's — the same outcome as if they had passed their
 *     own id, or none at all. `routes/tags.js`'s `GET /` never reads
 *     `req.params`/`req.body` for a user id at all (`getConversationTags`
 *     is invoked with `req.user.id`, the token's own subject — see
 *     `api/server/routes/tags.js`), so no live caller can even SUPPLY a
 *     different value through the public surface; the discard is a
 *     defence-in-depth invariant of the base, not an exploitable gap of
 *     this domain. Undisclosed at the domain level before this round;
 *     disclosed here rather than assumed obvious.
 *
 *  B. **The status code an `importBatchBuilder.js` consumer's user sees
 *     when a `.`/`..` tag element throws 400 out of `Promise.all` is
 *     HTTP 500, generic, body `"Error processing file"` — the SAME shape
 *     as DISCLOSED CONSEQUENCE §9's account-deletion trace, traced fresh
 *     through this chain:** a `.`/`..` element in
 *     `convo.tags` reaches `bulkIncrementTagCounts(user, tags)`
 *     (`importBatchBuilder.js:198`) unfiltered (`isId` accepts any
 *     non-empty string, `.`/`..` included); this domain's `impl` maps it
 *     into `this.updateById('.', ...)` inside `Promise.all(unique.map(...))`;
 *     `updateById`'s `fetchRaw` calls `callProxy({path: '.'})`, whose
 *     `encodeTagPath` throws the 400 `SovereignMemoryError`
 *     BEFORE any network hop; that rejection propagates out of the mapped
 *     promise and `Promise.all` rejects the WHOLE `bulkIncrementTagCounts`
 *     call immediately (an in-flight sibling increment may already have
 *     committed — DISCLOSED CONSEQUENCE §7's partial-commit window is the
 *     same mechanism); `bulkIncrementTagCounts`'s promise is one of the
 *     THREE in `saveBatch()`'s own `Promise.all([...])`
 *     (`importBatchBuilder.js:190-199`), which rejects the same way;
 *     `saveBatch()`'s `catch` (`importBatchBuilder.js:200-203`) logs and
 *     RE-THROWS the SAME error; `importConversations()`'s `catch`
 *     (`importConversations.js:38-40`) logs and RE-THROWS again
 *     (deliberately — its own comment: "throw error all the way up so
 *     request does not return success"); `routes/convos.js`'s
 *     `POST /import` handler's `catch` (line ~706) checks
 *     `isContentFilterError(error)` first — a `SovereignMemoryError` is
 *     none of `ContentFilterError`/`ContentTraversalLimitError`/
 *     `UninspectableFileError` (`packages/api/src/middleware/
 *     contentFilter.ts`'s `getContentFilterError`), so this is `false` —
 *     and falls through to the generic branch:
 *     `res.status(500).send('Error processing file')`. The underlying
 *     400 — and which tag caused it — is never surfaced to the user; the
 *     whole import is reported as a bare, undifferentiated failure.
 */

jest.mock('./client', () => ({ callConsoleConversationTagsProxy: jest.fn() }));
jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { callConsoleConversationTagsProxy } = require('./client');
const { runWithRequestAccessToken } = require('../AuditTraceConversations/requestContext');
const { SovereignMemoryError } = require('../AuditTraceMemory/errors');
const { SOVEREIGN_METHOD_BINDERS } = require('./index');

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

/**
 * The generated table's raw material: every `callProxy` invocation this
 * run captured, in call order, as `{method, path, query, body}`.
 * @returns {Array<{method: string, path: string, query?: object, body?: unknown}>}
 */
const capture = () =>
  callConsoleConversationTagsProxy.mock.calls.map(([args]) => ({
    method: args.method,
    path: args.path,
    query: args.query,
    body: args.body,
  }));

describe('AuditTraceConversationTags — WIRE PROBE (ADDENDUM G): the surface table generated from captured callProxy calls', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it("getConversationTags — own-list, then the NEXT PAGE echoes the BFF's next_cursor verbatim into the query string", async () => {
    callConsoleConversationTagsProxy
      .mockResolvedValueOnce({ items: [row('a')], next_cursor: 'SENTINEL_CURSOR' })
      .mockResolvedValueOnce({ items: [], next_cursor: null });
    await withToken(() => bind('getConversationTags')('lc-user-1'));
    expect(capture()).toEqual([
      { method: 'GET', path: '', query: { limit: '100' }, body: undefined },
      {
        method: 'GET',
        path: '',
        query: { limit: '100', cursor: 'SENTINEL_CURSOR' },
        body: undefined,
      },
    ]);
  });

  it('createConversationTag — THREE wire calls in sequence: GET path (readOne) -> GET query-string (listOwn maxPosition scan) -> POST body (create)', async () => {
    callConsoleConversationTagsProxy
      .mockRejectedValueOnce(notFound()) // readOne('SENTINEL_TAG_1') miss
      .mockResolvedValueOnce({ items: [row('other', { position: 4 })], next_cursor: null }) // listOwn
      .mockResolvedValueOnce(row('SENTINEL_TAG_1', { position: 5, count: 0 })); // create
    await withToken(() =>
      bind('createConversationTag')('lc-user-1', {
        tag: 'SENTINEL_TAG_1',
        description: 'SENTINEL_DESC_1',
      }),
    );
    expect(capture()).toEqual([
      { method: 'GET', path: 'SENTINEL_TAG_1', query: undefined, body: undefined },
      { method: 'GET', path: '', query: { limit: '100' }, body: undefined },
      {
        method: 'POST',
        path: '',
        query: undefined,
        body: {
          tag: 'SENTINEL_TAG_1',
          description: 'SENTINEL_DESC_1',
          count: 0,
          position: 5,
          metadata: {},
        },
      },
    ]);
  });

  it('updateConversationTag (plain description change) — TWO wire calls: GET path (fetchRaw pre-read) -> POST body (upsert)', async () => {
    callConsoleConversationTagsProxy
      .mockResolvedValueOnce(row('SENTINEL_TAG_2', { description: 'old', count: 3, position: 2 }))
      .mockResolvedValueOnce(
        row('SENTINEL_TAG_2', { description: 'SENTINEL_DESC_2', count: 3, position: 2 }),
      );
    await withToken(() =>
      bind('updateConversationTag')('lc-user-1', 'SENTINEL_TAG_2', {
        description: 'SENTINEL_DESC_2',
      }),
    );
    expect(capture()).toEqual([
      { method: 'GET', path: 'SENTINEL_TAG_2', query: undefined, body: undefined },
      {
        method: 'POST',
        path: '',
        query: undefined,
        body: {
          tag: 'SENTINEL_TAG_2',
          description: 'SENTINEL_DESC_2',
          count: 3,
          position: 2,
          metadata: {},
        },
      },
    ]);
  });

  it('deleteConversationTag — TWO wire calls: GET path (fetchRaw pre-read) -> DELETE path', async () => {
    callConsoleConversationTagsProxy.mockResolvedValueOnce(row('SENTINEL_TAG_3'));
    callConsoleConversationTagsProxy.mockResolvedValueOnce(undefined);
    await withToken(() => bind('deleteConversationTag')('lc-user-1', 'SENTINEL_TAG_3'));
    expect(capture()).toEqual([
      { method: 'GET', path: 'SENTINEL_TAG_3', query: undefined, body: undefined },
      { method: 'DELETE', path: 'SENTINEL_TAG_3', query: undefined, body: undefined },
    ]);
  });

  it('deleteConversationTags({user: caller}) — listOwn QUERY STRING, then a fetchRaw PATH + DELETE PATH pair per owned tag (no batchGet for this domain)', async () => {
    callConsoleConversationTagsProxy
      .mockResolvedValueOnce({
        items: [row('SENTINEL_TAG_A'), row('SENTINEL_TAG_B')],
        next_cursor: null,
      }) // listOwn
      .mockResolvedValueOnce(row('SENTINEL_TAG_A')) // resolveByIds fetchRaw A
      .mockResolvedValueOnce(row('SENTINEL_TAG_B')) // resolveByIds fetchRaw B
      .mockResolvedValueOnce(undefined) // DELETE A
      .mockResolvedValueOnce(undefined); // DELETE B
    const mongoFn = jest.fn().mockResolvedValue(0);
    const calls = capture; // captured lazily below, after the call resolves
    await withToken(() => bind('deleteConversationTags', mongoFn)({ user: 'lc-user-1' }));
    expect(calls()).toEqual([
      { method: 'GET', path: '', query: { limit: '100' }, body: undefined },
      { method: 'GET', path: 'SENTINEL_TAG_A', query: undefined, body: undefined },
      { method: 'GET', path: 'SENTINEL_TAG_B', query: undefined, body: undefined },
      { method: 'DELETE', path: 'SENTINEL_TAG_A', query: undefined, body: undefined },
      { method: 'DELETE', path: 'SENTINEL_TAG_B', query: undefined, body: undefined },
    ]);
    expect(calls()).toHaveLength(5);
    expect(mongoFn).toHaveBeenCalledWith({ user: 'lc-user-1' });
  });

  it('bulkIncrementTagCounts — TWO wire calls per owned tag: GET path (fetchRaw pre-read) -> POST body (count-increment upsert)', async () => {
    callConsoleConversationTagsProxy
      .mockResolvedValueOnce(row('SENTINEL_TAG_X', { description: 'd', count: 2, position: 1 }))
      .mockResolvedValueOnce(row('SENTINEL_TAG_X', { description: 'd', count: 3, position: 1 }));
    await withToken(() => bind('bulkIncrementTagCounts')('lc-user-1', ['SENTINEL_TAG_X']));
    expect(capture()).toEqual([
      { method: 'GET', path: 'SENTINEL_TAG_X', query: undefined, body: undefined },
      {
        method: 'POST',
        path: '',
        query: undefined,
        body: { tag: 'SENTINEL_TAG_X', description: 'd', count: 3, position: 1, metadata: {} },
      },
    ]);
  });
});
