/**
 * THE WIRE PROBE (Addendum G —
 * `2026-09-17-SPEC-ADDENDUM-G-derive-the-surface-table-from-the-WIRE-not-
 * from-reading.md`), applied to this domain from the start rather than
 * discovered by a reject round.
 *
 * Mocks ONLY `./client` and the logger (`@librechat/data-schemas`) — the
 * base (`AuditTraceSovereignAdapter`), this domain's declaration
 * (`index.js`), and the shared `requestContext` ALS are REAL, unmocked
 * code, exactly like `AuditTraceConversationTags/wireProbe.spec.js`.
 * Every sentinel value below is chosen to be unique and traceable through
 * the capture so a reviewer can see exactly which call produced which row
 * without cross-referencing `index.js`.
 *
 * **Scope.** All THREE wired methods (`getToolFavorites`,
 * `addToolFavorite`, `removeToolFavorite`) are wholly wired for a valid
 * `itemType` — there is no disclosed-unwired method and no narrower
 * Mongo-native carve-out WITHIN a wired method the way
 * `AuditTraceConversationTags` has (its `addToConversation`/rename/
 * reposition shapes). The one Mongo-deferral shape this domain has — an
 * invalid `itemType` — makes ZERO `callProxy` calls by construction (it
 * defers immediately); pinned behaviourally in `index.spec.js`, not
 * re-probed here.
 *
 * ============================================================
 * THE GENERATED TABLE (one block per `it()` below; PATH / QUERY STRING /
 * JSON BODY named for every caller-supplied value that crosses the wire,
 * per ADDENDUM G point 3)
 * ============================================================
 *
 *   getToolFavorites        GET  path:""  query:{limit:"100"}            -> QUERY STRING
 *                                (`readByFilter`'s own-list branch ->
 *                                 `listOwn` — ONE call; no next_cursor in
 *                                 the mocked response so the page loop
 *                                 stops after one)
 *
 *   addToolFavorite (new)   GET  path:""  query:{limit:"100"}            -> QUERY STRING
 *                                (the existence pre-check — this domain
 *                                 has NO get-by-key route, so `listOwn`
 *                                 substitutes for it; see `index.js`'s
 *                                 module docstring)
 *                           POST path:""  body:{item_type:"mcp",
 *                                               item_id:"SENTINEL_ITEM_1"} -> JSON BODY
 *                                (`this.create`; both `item_type` AND
 *                                 `item_id` are caller-supplied values
 *                                 crossing in the body)
 *
 *   addToolFavorite         GET  path:""  query:{limit:"100"}            -> QUERY STRING
 *   (already owned)              (existence pre-check finds the pair
 *                                 already present; NO `create`/POST call
 *                                 follows — this is the row a naive
 *                                 "compose deleteById" reading would not
 *                                 even think to probe, since there is no
 *                                 analogous read-then-write shape on the
 *                                 delete side)
 *
 *   addToolFavorite         GET  path:""  query:{limit:"100"}            -> QUERY STRING
 *   (cap exceeded)          POST path:""  body:{item_type:"tool",
 *                                               item_id:"SENTINEL_ITEM_2"} -> JSON BODY
 *                                (the POST itself is the call that 409s;
 *                                 captured even though it rejects)
 *
 *   removeToolFavorite      DELETE path:"mcp/SENTINEL_ITEM_3"            -> URL PATH
 *   (sovereign hit)               (`this.callProxy` called DIRECTLY —
 *                                 NOT `this.deleteById` — see `index.js`'s
 *                                 module docstring for why; no GET
 *                                 precedes it, unlike every other domain's
 *                                 delete)
 *
 *   removeToolFavorite      DELETE path:"tool/SENTINEL_ITEM_4"           -> URL PATH
 *   (sovereign miss,               (the DELETE itself 404s; caught as
 *    Mongo sweep still runs)        "not found" — `deferToMongo` then
 *                                   runs as a SEPARATE call, captured on
 *                                   the `mongoFn` mock, NOT on
 *                                   `callProxy` — no second `callProxy`
 *                                   call for the Mongo sweep)
 *
 * ============================================================
 * PER-ROW SELF-CHECK (ADDENDUM G R5 — a row cleared with no captured call
 * behind it is not checked; every row above is checked against the named
 * `it()`, by exact-array `toEqual`, so an omission OR an addition fails
 * it)
 * ============================================================
 *  - getToolFavorites row -> checked against "own-list, single page"
 *    below (1 call asserted).
 *  - addToolFavorite (new) rows (both) -> checked against "existence
 *    pre-check then create" below (2 calls asserted, one `toEqual` on the
 *    whole captured array).
 *  - addToolFavorite (already owned) row -> checked against "existence
 *    pre-check finds the pair, no create" below (1 call asserted,
 *    `toHaveLength(1)` guards against a silently-added second call).
 *  - addToolFavorite (cap exceeded) rows (both) -> checked against "the
 *    cap rejection" below (2 calls asserted).
 *  - removeToolFavorite (sovereign hit) row -> checked against "a single
 *    DELETE, no GET precedes it" below (1 `callProxy` call asserted, PLUS
 *    an assertion that `mongoFn` is STILL called — the sweep always
 *    runs).
 *  - removeToolFavorite (sovereign miss) row -> checked against "the
 *    sovereign miss still sweeps Mongo" below (1 `callProxy` call
 *    asserted, its rejection swallowed).
 *
 * ============================================================
 * WHAT THIS PROBE ALSO PINS (a regression guard, not just an
 * enumeration): NO scenario above issues a `GET` to a `{item_type}/
 * {item_id}` shape. `index.js`'s module docstring explains why: a real
 * FastAPI `TestClient` reproduction (in the build record) shows that
 * shape 405s against the DELETE-only route, not 404s — so if a future
 * edit "simplifies" `removeToolFavorite` back to `this.deleteById(...)`,
 * this probe's mocked `callProxy` would see an extra `GET` call the
 * `toEqual`/`toHaveLength` assertions below do not expect, and (against
 * the real transport) that call would 405 instead of enabling the
 * pre-read `deleteById` needs.
 * ============================================================
 */

jest.mock('./client', () => ({ callConsoleToolFavoritesProxy: jest.fn() }));
jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
  FAVORITE_ITEM_TYPES: ['builtin', 'tool', 'mcp', 'skill'],
}));

const { callConsoleToolFavoritesProxy } = require('./client');
const { runWithRequestAccessToken } = require('../AuditTraceConversations/requestContext');
const { SovereignMemoryError } = require('../AuditTraceMemory/errors');
const { TOOL_FAVORITE_SOVEREIGN_METHOD_BINDERS } = require('./index');

const notFound = () => new SovereignMemoryError('not found', 404);
const capExceeded = () => new SovereignMemoryError('maximum of 100 tool favorites reached', 409);

/** Binds a chokepointed method the way `wrapModelMethods` does. */
const bind = (name, mongoFn = jest.fn(), mongoMethods = {}) =>
  TOOL_FAVORITE_SOVEREIGN_METHOD_BINDERS[name]('tok', mongoFn, mongoMethods);

const withToken = (fn) => runWithRequestAccessToken({ accessToken: 'tok', sub: 'lc-user-1' }, fn);

/**
 * The generated table's raw material: every `callProxy` invocation this
 * run captured, in call order, as `{method, path, query, body}`.
 * @returns {Array<{method: string, path: string, query?: object, body?: unknown}>}
 */
const capture = () =>
  callConsoleToolFavoritesProxy.mock.calls.map(([args]) => ({
    method: args.method,
    path: args.path,
    query: args.query,
    body: args.body,
  }));

describe('AuditTraceToolFavorites — WIRE PROBE (Addendum G): the surface table generated from captured callProxy calls', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it('getToolFavorites — own-list, single page (no next_cursor)', async () => {
    callConsoleToolFavoritesProxy.mockResolvedValueOnce({
      items: [{ item_type: 'mcp', item_id: 'existing' }],
      next_cursor: null,
    });
    await withToken(() => bind('getToolFavorites')('lc-user-1'));
    expect(capture()).toEqual([
      { method: 'GET', path: '', query: { limit: '100' }, body: undefined },
    ]);
  });

  it('addToolFavorite (new pair) — existence pre-check (GET query) then create (POST body)', async () => {
    callConsoleToolFavoritesProxy
      .mockResolvedValueOnce({ items: [], next_cursor: null }) // listOwn existence check
      .mockResolvedValueOnce({
        item_type: 'mcp',
        item_id: 'SENTINEL_ITEM_1',
        tenant_id: null,
        created_at_ms: 1,
        updated_at_ms: 1,
        deleted_at_ms: null,
        metadata: {},
      }); // create
    const result = await withToken(() =>
      bind('addToolFavorite')({ userId: 'lc-user-1', itemType: 'mcp', itemId: 'SENTINEL_ITEM_1' }),
    );
    expect(result).toEqual({ ok: true, added: true });
    expect(capture()).toEqual([
      { method: 'GET', path: '', query: { limit: '100' }, body: undefined },
      {
        method: 'POST',
        path: '',
        query: undefined,
        body: { item_type: 'mcp', item_id: 'SENTINEL_ITEM_1' },
      },
    ]);
  });

  it('addToolFavorite (already owned) — existence pre-check finds the pair, NO create call follows', async () => {
    callConsoleToolFavoritesProxy.mockResolvedValueOnce({
      items: [{ item_type: 'tool', item_id: 'SENTINEL_ITEM_ALREADY' }],
      next_cursor: null,
    });
    const result = await withToken(() =>
      bind('addToolFavorite')({
        userId: 'lc-user-1',
        itemType: 'tool',
        itemId: 'SENTINEL_ITEM_ALREADY',
      }),
    );
    expect(result).toEqual({ ok: true, added: false });
    expect(capture()).toEqual([
      { method: 'GET', path: '', query: { limit: '100' }, body: undefined },
    ]);
    expect(capture()).toHaveLength(1);
  });

  it('addToolFavorite (cap exceeded) — the POST itself 409s, both calls captured', async () => {
    callConsoleToolFavoritesProxy
      .mockResolvedValueOnce({ items: [], next_cursor: null }) // listOwn existence check
      .mockRejectedValueOnce(capExceeded()); // create -> 409
    await expect(
      withToken(() =>
        bind('addToolFavorite')({
          userId: 'lc-user-1',
          itemType: 'tool',
          itemId: 'SENTINEL_ITEM_2',
        }),
      ),
    ).rejects.toMatchObject({ code: 'MAX_FAVORITES_EXCEEDED', limit: 100 });
    expect(capture()).toEqual([
      { method: 'GET', path: '', query: { limit: '100' }, body: undefined },
      {
        method: 'POST',
        path: '',
        query: undefined,
        body: { item_type: 'tool', item_id: 'SENTINEL_ITEM_2' },
      },
    ]);
  });

  it('removeToolFavorite (sovereign hit) — a single DELETE, no GET precedes it; Mongo sweep still runs', async () => {
    callConsoleToolFavoritesProxy.mockResolvedValueOnce(undefined); // DELETE succeeds
    const mongoFn = jest.fn().mockResolvedValue({ ok: true, removed: false });
    const result = await withToken(() =>
      bind(
        'removeToolFavorite',
        mongoFn,
      )({
        userId: 'lc-user-1',
        itemType: 'mcp',
        itemId: 'SENTINEL_ITEM_3',
      }),
    );
    expect(result).toEqual({ ok: true, removed: true });
    expect(capture()).toEqual([
      { method: 'DELETE', path: 'mcp/SENTINEL_ITEM_3', query: undefined, body: undefined },
    ]);
    expect(mongoFn).toHaveBeenCalledWith({
      userId: 'lc-user-1',
      itemType: 'mcp',
      itemId: 'SENTINEL_ITEM_3',
    });
  });

  it('removeToolFavorite (sovereign miss) — the DELETE 404s (swallowed), Mongo sweep still runs and wins', async () => {
    callConsoleToolFavoritesProxy.mockRejectedValueOnce(notFound());
    const mongoFn = jest.fn().mockResolvedValue({ ok: true, removed: true });
    const result = await withToken(() =>
      bind(
        'removeToolFavorite',
        mongoFn,
      )({
        userId: 'lc-user-1',
        itemType: 'tool',
        itemId: 'SENTINEL_ITEM_4',
      }),
    );
    expect(result).toEqual({ ok: true, removed: true });
    expect(capture()).toEqual([
      { method: 'DELETE', path: 'tool/SENTINEL_ITEM_4', query: undefined, body: undefined },
    ]);
    expect(mongoFn).toHaveBeenCalledTimes(1);
  });
});
