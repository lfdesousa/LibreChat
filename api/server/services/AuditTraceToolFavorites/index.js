/**
 * The sovereign-tool-favorites adapter — the SEVENTH domain folded behind
 * `AuditTraceSovereignAdapter` (MongoDB-elimination EPIC,
 * `2026-09-17-SPEC-mongo-repl-wu-tool-favorites-fork-chokepoint-shim.md`
 * AS AMENDED (pre-dispatch, authoring-time) by
 * `2026-09-17-SPEC-ADDENDUM-G-derive-the-surface-table-from-the-WIRE-not-from-reading.md`,
 * which WINS where they differ): this module writes NO read/fallthrough/
 * owner-stamping/undefined-key-guard/clobber-merge logic of its own —
 * every one of those lives in `../AuditTraceSovereignAdapter` and is
 * proven there ONCE. `../AuditTraceFiles` is the reference adopter this
 * module otherwise follows; `../AuditTraceChatProjects` is the pre-base
 * sibling this module deliberately does NOT copy. ONE deliberate,
 * disclosed departure from "compose only the base primitives" is
 * documented below (`removeToolFavorite`) — everything else composes
 * `readByFilter`/`create`/`listOwn`/`deferToMongo` exactly as the base
 * intends.
 *
 * ============================================================
 * GROUND-THE-SURFACE ENUMERATION (set-equality)
 * ============================================================
 * `createToolFavoriteMethods(mongoose)`
 * (`packages/data-schemas/src/methods/favorite.ts`) returns an object
 * whose keys are, by set-equality against the function body's own
 * `return {...}` statement, EXACTLY three:
 *
 *   `getToolFavorites`, `addToolFavorite`, `removeToolFavorite`.
 *
 * No standalone function is exported alongside them the way
 * `AuditTraceConversationTags`'s `decrementTagCounts` is — `favorite.ts`
 * has no such sibling (grep: `grep -n "^export" packages/data-schemas/src/methods/favorite.ts`
 * finds only `MAX_TOOL_FAVORITES` and `createToolFavoriteMethods`).
 *
 * **Every consumer of the three named methods, module-load capture
 * included** (grep: `grep -rn "getToolFavorites\|addToolFavorite\|removeToolFavorite"
 * api/ packages/ --include="*.ts" --include="*.js"`, excluding the
 * defining/type files):
 *  - **`api/server/routes/settings.js`** — ALL THREE, destructured from
 *    `require('~/models')` (the chokepoint export) at module-evaluation
 *    time, wrapped by `createToolFavoritesHandlers({getToolFavorites,
 *    addToolFavorite, removeToolFavorite})` (`@librechat/api` ==
 *    `packages/api/src/favorites/handlers.ts`), and mounted:
 *    `GET /favorites/tools` (list), `PUT /favorites/tools/:itemType/:itemId`
 *    (add), `DELETE /favorites/tools/:itemType/:itemId` (remove). This
 *    module obtains its function references AFTER `api/models/index.js`
 *    has already run `wrapModelMethods(...)` once at module-evaluation
 *    time (the SAME ordering every prior domain's shim already relies
 *    on), so no module-load-time capture pins a raw, unwrapped reference
 *    ahead of the chokepoint.
 *  - **`packages/api/src/favorites/handlers.ts`** — NOT an independent
 *    consumer: it is the DEPENDENCY-INJECTED handler factory
 *    `settings.js` feeds the three functions above INTO (`deps.
 *    getToolFavorites`/`addToolFavorite`/`removeToolFavorite`); it never
 *    imports `~/models` itself. Confirmed by its own type signature
 *    (`ToolFavoritesHandlersDeps`) — the caller supplies the
 *    implementations, this module only calls them. Its error-shape
 *    contract on `addToolFavorite`'s rejection (`capError.code ===
 *    'MAX_FAVORITES_EXCEEDED'`) is DISCLOSED CONSEQUENCE §1 below.
 *  - **`packages/data-provider/src/data-service.ts`** — CONFIRMED the
 *    *client* HTTP layer (`getToolFavorites`/`addToolFavorite`/
 *    `removeToolFavorite` there call `request.get/put/delete` against
 *    `/api/favorites/tools/...` — the browser-side fetch wrapper), never
 *    a `~/models` consumer and never reachable from this chokepoint.
 *  - No injected-`methods`-parameter caller and no direct
 *    `createToolFavoriteMethods(...)` call outside
 *    `packages/data-schemas/src/methods/index.ts` (the aggregator every
 *    other domain's shim already found clean) exists for this domain
 *    (grep: `grep -rn "createToolFavoriteMethods" api/ packages/` finds
 *    only the aggregator's import + call).
 *
 * ============================================================
 * WHAT IS WIRED (all THREE methods, whole — no disclosed-unwired shape)
 * ============================================================
 *  - **`getToolFavorites(userId)`** — WIRED, whole. Own-scoped list via
 *    the base's `readByFilter` own-list shape, trimmed to the exact
 *    `{itemType, itemId}` lean projection Mongo's own `.select(...)`
 *    returns (DISCLOSED CONSEQUENCE §2 for the sovereign-only read
 *    scope; DISCLOSED CONSEQUENCE §3 for the discarded `userId`).
 *  - **`addToolFavorite({userId, itemType, itemId})`** — WIRED, whole,
 *    for a valid `itemType` (DISCLOSED CONSEQUENCE §4 for an invalid
 *    one). Idempotent: an existing pair returns `{ok: true, added:
 *    false}` without a write; a new pair calls `this.create` and returns
 *    `{ok: true, added: true}`. A cap rejection is re-shaped into the
 *    fork's OWN `MAX_FAVORITES_EXCEEDED`-coded error (DISCLOSED
 *    CONSEQUENCE §1).
 *  - **`removeToolFavorite({userId, itemType, itemId})`** — WIRED, whole,
 *    for a valid `itemType` (DISCLOSED CONSEQUENCE §4). See the
 *    dedicated docstring below `removeToolFavorite`'s `impl` for why this
 *    is the ONE method that does not compose `deleteById`/`deleteByIds`.
 *
 * ============================================================
 * ⚠ WHY `removeToolFavorite` DOES NOT COMPOSE `deleteById`/`deleteByIds`
 * (Addendum G — verified by a committed reproduction, not assumed)
 * ============================================================
 * `2026-09-13-SPEC-mongo-repl-wu-tool-favorites-store.md` built this
 * domain's orchestrator API with deliberately only THREE routes — `POST
 * ""` (add), `GET ""` (list), `DELETE "/{item_type}/{item_id:path}"`
 * (remove) — "no standalone get-by-key route (the fork's own `methods/
 * favorite.ts` never exposes one either)." The base's `deleteById`
 * (and, via `resolveByIds`, `deleteByIds` — this domain has no
 * `batchGet` route either) BOTH pre-read the target with `fetchRaw`
 * (`callProxy({method: 'GET', path: id})`) BEFORE ever attempting the
 * delete, so they can decide sovereign-vs-Mongo. With no GET route at
 * this path shape, that pre-read does not 404 (which `isNotFound` would
 * treat as "not found, defer to Mongo") — it hits the DELETE-only
 * route's own PATH PATTERN with the wrong METHOD, which Starlette
 * answers **405 Method Not Allowed**, a status `isNotFound` does not
 * recognize, so it PROPAGATES OUT of `fetchRaw`, crashing
 * `deleteById`/`deleteByIds` on every real call. Verified with a
 * `fastapi.testclient.TestClient` reproduction (`FastAPI` + one `GET ""`,
 * one `POST ""`, one `DELETE "/{item_type}/{item_id:path}"` route,
 * mirroring `routes/console_tool_favorites.py` exactly):
 *
 * ```
 * GET base:                                 200
 * GET by key:                               405   <- not 404
 * DELETE by key:                            204
 * POST by key (wrong method on delete path): 405
 * ```
 *
 * (The build record carries the full transcript, including the earlier
 * live-cluster probes that first ruled out an Istio-gateway-level 404
 * before this in-process reproduction pinned the actual FastAPI
 * behaviour.) Composing `deleteById` here would not silently
 * misbehave — it would THROW on every call, a regression a naive
 * "compose the primitive named `deleteById`" reading of contract trap
 * #1 would not catch. `removeToolFavorite`'s `impl` therefore calls
 * `this.callProxy` directly for the ONE unconditional DELETE this domain
 * needs, translating that call's OWN 404 (the route's own "not found"
 * signal, already RLS/`user_sub`-scoped server-side — see
 * `routes/console_tool_favorites.py`'s docstring) into `removed: false`
 * exactly the way `isNotFound`/`fetchRaw` do elsewhere. This is NOT a
 * raw-Mongo escape (`this.callProxy` is this domain's OWN declared HTTP
 * transport, never a `mongoFn`/`mongoMethods` callable — the base's
 * undefined-key guard machinery has nothing to do with it), and it
 * reinvents none of the base's owned invariants (owner-stamping,
 * undefined-key short-circuit, RLS scoping): the orchestrator's own
 * query is already scoped to the caller's `user_sub`, so a client-side
 * pre-read adds no safety this domain's design forgoes.
 *
 * `../AuditTraceSovereignAdapter/wireProbe.spec.js`-style capture (this
 * domain's `./wireProbe.spec.js`) pins the CONSEQUENCE of this choice —
 * `removeToolFavorite` never issues a `GET` to a `{item_type}/{item_id}`
 * path — as a regression guard: reverting to `deleteById` would make
 * that probe's mocked `callProxy` see a `GET` call it does not expect
 * AND (against the real transport) would 405.
 *
 * ============================================================
 * DISCLOSED CONSEQUENCES (deploy-acceptance — stated, not hidden)
 * ============================================================
 *  1. **The cap error is RE-SHAPED, not relayed.** The orchestrator
 *     answers a capped `POST` with **HTTP 409**, `detail` a plain string
 *     (`services/console_tool_favorites.py::ToolFavoritesCapExceededError`
 *     -> `HTTPException(409, detail=str(exc))`) — no `.code`/`.limit` on
 *     the wire at all. `packages/api/src/favorites/handlers.ts`'s
 *     `addToolFavorite` branches on `capError.code === 'MAX_FAVORITES_EXCEEDED'`
 *     (answering the CALLER **HTTP 400**, `{code, message, limit}`) and
 *     falls through to a generic 500 for anything else. This domain
 *     therefore catches the 409 `SovereignMemoryError` and throws a NEW
 *     `Error` shaped exactly like `favorite.ts`'s own `capError()`
 *     (`.code = 'MAX_FAVORITES_EXCEEDED'`, `.limit = MAX_TOOL_FAVORITES`,
 *     message `` `Maximum of ${MAX_TOOL_FAVORITES} favorites reached` ``)
 *     — the ORIGINAL contract, not the orchestrator's wire shape.
 *     Verified with a side-effect assertion in `index.spec.js` (a
 *     mocked 409 turns into a rejection matching `{code, limit}` via
 *     `toMatchObject`, mirroring `favorite.spec.ts`'s own assertion
 *     style byte-for-byte).
 *  2. **`getToolFavorites` is sovereign-only; a pre-migration, Mongo-only
 *     favorite is invisible to it.** The base's own-list read discipline
 *     never merges a Mongo result (`AuditTraceSovereignAdapter::
 *     readByFilter`'s `own-list` branch returns straight from
 *     `this.listOwn(token)`, with no `ctx.fallback` call at all — the
 *     SAME disclosed shape `AuditTraceConversationTags::
 *     getConversationTags` already carries). `ctx.mongoFn` is wired into
 *     this method's `impl` for signature symmetry with every other
 *     migrated domain, but is UNREACHABLE dead code for this call shape
 *     (a filter of exactly `{[ownerField]: userId}` with `userId` a
 *     non-empty string always classifies `own-list`, never `ids` or
 *     `residual`) — named here rather than silently carried.
 *  3. **`getToolFavorites(userId)`'s `classifyFilter` STAGE discards its
 *     caller-supplied `userId`, but the OWNER-equality POST-filter then
 *     acts on it — the net effect is EMPTY, not "your own list anyway."**
 *     Related to, but MORE PRECISE than, the finding
 *     `AuditTraceConversationTags`'s Addendum-G fix round disclosed for
 *     its own `getConversationTags(user)` (that module's prose says a
 *     mismatched id "receives their OWN tags" — this domain's OWN test
 *     (`index.spec.js`) proves the actual mechanism empirically rather
 *     than repeating that claim unverified): `classifyFilter({user:
 *     userId}, ...)` only checks that the value is a non-empty STRING to
 *     select the `own-list` shape, so the DATA FETCH
 *     (`this.listOwn(token)`) is always token-scoped regardless of
 *     `userId`'s value — no cross-user Mongo call, no leak. But
 *     `readByFilter`'s own-list branch then applies
 *     `matchesExtraConstraints(record, filter, this)` as a POST-filter,
 *     and the OWNER key is checked there by PLAIN EQUALITY against the
 *     record's stamped owner (`../AuditTraceSovereignAdapter/filters.js`'s
 *     own docstring: "a faithful predicate, NOT a scoping decision"). A
 *     `userId` that differs from the live token subject therefore fails
 *     that equality for EVERY returned row, so the caller sees an EMPTY
 *     list, never their own favorites served back "as if" they had
 *     asked correctly, and never a stranger's. **Disclosed and ACCEPTED,
 *     not a bug:** fail-SAFE either way. `routes/settings.js`'s
 *     `GET /favorites/tools` -> `handlers.ts::listToolFavorites` invokes
 *     this with `req.user?.id` (the token's own subject) always, so no
 *     live caller can even present a different `userId` through the
 *     public surface today.
 *  4. **An `itemType` outside `FAVORITE_ITEM_TYPES` is Mongo-native for
 *     the whole call**, on all three methods. `favorite.spec.ts`'s own
 *     "rejects an itemType outside the enum" case documents that Mongo
 *     already refuses this (a Mongoose enum-validation rejection); this
 *     domain has no sovereign-side validator to replicate that exact
 *     rejection shape, so it defers the WHOLE call rather than inventing
 *     one. Not reachable through the live HTTP path — `packages/api/src/
 *     favorites/handlers.ts`'s `validateParams` already answers **HTTP
 *     400** `{code: 'INVALID_ITEM_TYPE', ...}` before `deps.
 *     addToolFavorite`/`removeToolFavorite`/`getToolFavorites` is ever
 *     called — named because a direct model-level caller (a test, a
 *     script) is not bound by that route-level check.
 *  5. **`addToolFavorite` has a read-then-write existence check, exactly
 *     like the ORIGINAL Mongo method (`ToolFavorite.exists(filter)` then
 *     `updateOne(..., {upsert: true})`), and inherits the SAME
 *     acknowledged race window** ("the cap check is read-then-write and
 *     may transiently overshoot by one or two under concurrency —
 *     acceptable for a soft UX cap", `favorite.ts`'s own docstring). This
 *     domain's existence check is `this.listOwn(token)` (permitted
 *     primitive; no GET-by-key route exists — see the `removeToolFavorite`
 *     discussion above) followed by `this.create`; two concurrent adds of
 *     the SAME pair can each see "not present" and both call `create` —
 *     the orchestrator's own upsert is idempotent (migration 030's
 *     unique constraint), so no duplicate row results, but BOTH calls
 *     may report `added: true` under a genuine race (Mongo's unique-index
 *     backstop reports the SAME symptom for a duplicate-key rejection
 *     mid-race — `favorite.ts`'s own "concurrent duplicate adds do not
 *     throw" test only asserts `ok: true` for exactly this reason, never
 *     asserting `added` under a race).
 *  6. **A legacy Mongo-only favorite is independently removable — for the
 *     two outcomes this domain treats as decided, not for a genuine
 *     failure.** `removeToolFavorite` attempts the sovereign DELETE, and
 *     for its TWO recognized outcomes — a success, OR its OWN 404 (`isNotFound`)
 *     — ALSO runs `this.deferToMongo` regardless of which of those two it
 *     was, the SAME "run the whole sweep, never narrow it" discipline
 *     `AuditTraceConversationTags`'s Addendum-F fix round settled on for
 *     `deleteConversationTags` (DISCLOSED CONSEQUENCE §4 there) — so a
 *     caller who added a favorite before the sovereign backend went live
 *     can still remove it. **A THIRD outcome — any non-404 error (401,
 *     403, 502, …) — is NOT one of those two: it PROPAGATES immediately,
 *     and the Mongo sweep never runs at all** (`index.spec.js`'s "a
 *     NON-404 sovereign error PROPAGATES — the Mongo sweep never runs"
 *     pins this; a genuine failure must never be silently downgraded to
 *     "swept, reported removed:false"). For the two recognized outcomes,
 *     the sweep is two independent round trips, no shared transaction: a
 *     failure BETWEEN them can leave one store cleared and the other not
 *     (the same partial-commit class `AuditTraceConversationTags`
 *     discloses for its own dual-store sweep).
 *
 * **Chokepoint:** this module exports ONLY its adapter + binders. The
 * sovereign-vs-Mongo decision stays in
 * `AuditTraceConversations/index.js::wrapModelMethods` (ONE call site in
 * `api/models/index.js`, ONE `AsyncLocalStorage`), which merges
 * `SOVEREIGN_METHOD_BINDERS` below into `ALL_SOVEREIGN_METHOD_BINDERS`.
 */

const { logger } = require('@librechat/data-schemas');
const { FAVORITE_ITEM_TYPES } = require('@librechat/data-schemas');
const { AuditTraceSovereignAdapter, isNotFound } = require('../AuditTraceSovereignAdapter');
const { SovereignMemoryError } = require('../AuditTraceMemory/errors');
const { callConsoleToolFavoritesProxy } = require('./client');
const { toLeanFavorite, deriveCompositeKey, apiToFavorite, favoriteAddBody } = require('./mapping');

/** Mirrors the fork's OWN `methods/favorite.ts::MAX_TOOL_FAVORITES` and
 * the orchestrator's `services/console_tool_favorites.py::
 * MAX_TOOL_FAVORITES` — both already independent constants (no shared
 * import path crosses the Python/JS boundary); this is the THIRD
 * intentional duplicate, not a new anti-pattern. */
const MAX_TOOL_FAVORITES = 100;

/** No pagination on the orchestrator's list route (bounded by the cap);
 * one page covers every possible row. */
const LIST_PAGE_SIZE = MAX_TOOL_FAVORITES;
const LIST_MAX_PAGES = 1;

/** @param {unknown} v @returns {v is string} */
const isId = (v) => typeof v === 'string' && v.length > 0;

/** @param {unknown} v @returns {v is string} */
const isValidItemType = (v) => typeof v === 'string' && FAVORITE_ITEM_TYPES.includes(v);

/** @param {unknown} error @returns {boolean} */
function isCapExceeded(error) {
  return error instanceof SovereignMemoryError && error.status === 409;
}

/**
 * The fork's OWN cap-error shape (`packages/data-schemas/src/methods/
 * favorite.ts::capError`), reproduced byte-for-byte — see DISCLOSED
 * CONSEQUENCE §1.
 *
 * @returns {Error & {code: string, limit: number}}
 */
function capExceededError() {
  const error = new Error(`Maximum of ${MAX_TOOL_FAVORITES} favorites reached`);
  error.code = 'MAX_FAVORITES_EXCEEDED';
  error.limit = MAX_TOOL_FAVORITES;
  return error;
}

class AuditTraceToolFavoritesAdapter extends AuditTraceSovereignAdapter {
  constructor() {
    super({
      domain: 'toolFavorites',
      callProxy: callConsoleToolFavoritesProxy,
      idField: 'compositeKey',
      ownerField: 'user',
      fromApi: apiToFavorite,
      toApiBody: favoriteAddBody,
      batchGet: null,
      list: { pageSize: LIST_PAGE_SIZE, maxPages: LIST_MAX_PAGES },
      methods: {
        // Mongo: getToolFavorites(userId) — own-list, trimmed to the
        // lean {itemType, itemId} projection (DISCLOSED CONSEQUENCES
        // §2/§3).
        getToolFavorites: {
          kind: 'read',
          arity: 1,
          emptyResult: [],
          async impl([userId], ctx) {
            const items = await this.readByFilter(
              { [this.ownerField]: userId },
              { ...ctx, fallback: () => ctx.mongoFn(userId) },
            );
            return items.map(toLeanFavorite);
          },
        },
        // Mongo: addToolFavorite({userId, itemType, itemId}) — idempotent
        // create-or-report-existing (DISCLOSED CONSEQUENCES §1/§4/§5).
        addToolFavorite: {
          kind: 'write',
          arity: 1,
          async impl([params], ctx) {
            const src = params || {};
            if (!isValidItemType(src.itemType) || !isId(src.itemId)) {
              return this.deferToMongo(ctx, [src]);
            }
            const token = this.requireToken(ctx.token);
            // `listOwn` returns RAW api rows (snake_case `item_type`/
            // `item_id`) — it does NOT run them through `toDomain`/
            // `fromApi` (only `readByFilter`'s own-list branch does that,
            // see `getToolFavorites` above). Compared against the wire
            // shape directly; no mapping needed for an equality check.
            const own = await this.listOwn(token);
            const alreadyOwned = own.some(
              (item) => item.item_type === src.itemType && item.item_id === src.itemId,
            );
            if (alreadyOwned) {
              return { ok: true, added: false };
            }
            try {
              await this.create(
                deriveCompositeKey(src.itemType, src.itemId),
                { itemType: src.itemType, itemId: src.itemId },
                ctx,
              );
            } catch (error) {
              if (isCapExceeded(error)) {
                throw capExceededError();
              }
              throw error;
            }
            return { ok: true, added: true };
          },
        },
        // Mongo: removeToolFavorite({userId, itemType, itemId}) — see the
        // module docstring's dedicated section for why this does NOT
        // compose `deleteById`/`deleteByIds` (DISCLOSED CONSEQUENCE §6
        // for the dual-store sweep this composes instead).
        removeToolFavorite: {
          kind: 'write',
          arity: 1,
          async impl([params], ctx) {
            const src = params || {};
            if (!isValidItemType(src.itemType) || !isId(src.itemId)) {
              return this.deferToMongo(ctx, [src]);
            }
            const token = this.requireToken(ctx.token);
            let sovereignRemoved = false;
            try {
              await this.callProxy({
                method: 'DELETE',
                path: `${src.itemType}/${src.itemId}`,
                token,
              });
              sovereignRemoved = true;
            } catch (error) {
              if (!isNotFound(error)) {
                throw error;
              }
              logger.warn(
                '[AuditTraceToolFavorites] removeToolFavorite found no sovereign row for ' +
                  `${src.itemType}/${src.itemId} — sweeping Mongo only`,
              );
            }
            const mongoResult = await this.deferToMongo(ctx, [src]);
            const mongoRemoved = Boolean(mongoResult && mongoResult.removed);
            return { ok: true, removed: sovereignRemoved || mongoRemoved };
          },
        },
      },
    });
  }
}

const toolFavoritesAdapter = new AuditTraceToolFavoritesAdapter();

/**
 * The tool-favorites domain's contribution to the ONE chokepoint — built
 * by the base (fixed arities, `(token, mongoFn, mongoMethods)`
 * signature), merged into `ALL_SOVEREIGN_METHOD_BINDERS` by
 * `AuditTraceConversations/index.js`.
 */
const TOOL_FAVORITE_SOVEREIGN_METHOD_BINDERS = toolFavoritesAdapter.buildBinders();

module.exports = {
  AuditTraceToolFavoritesAdapter,
  toolFavoritesAdapter,
  TOOL_FAVORITE_SOVEREIGN_METHOD_BINDERS,
  MAX_TOOL_FAVORITES,
  LIST_PAGE_SIZE,
  LIST_MAX_PAGES,
  // Exported for direct unit testing only.
  _internal: { isValidItemType, isCapExceeded, capExceededError },
};
