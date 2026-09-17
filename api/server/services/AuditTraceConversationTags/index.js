/**
 * The sovereign-conversation-tags adapter — the SIXTH domain folded
 * behind `AuditTraceSovereignAdapter` (MongoDB-elimination EPIC,
 * `2026-09-13-SPEC-mongo-repl-wu-conversation-tags-fork-chokepoint-shim.md`
 * AS AMENDED by
 * `2026-09-17-SPEC-ADDENDUM-conv-tags-shim-folds-behind-the-adapter-base.md`
 * AS FURTHER AMENDED by
 * `2026-09-17-SPEC-ADDENDUM-E-enumerate-WHERE-a-value-lands-not-just-WHO-supplied-it.md`
 * (the F1 path-traversal fix round — `../client.js::encodeTagPath`,
 * DISCLOSED CONSEQUENCES §§1/2/7/8/9 below)
 * AS FURTHER AMENDED by
 * `2026-09-17-SPEC-ADDENDUM-F-apply-the-principle-to-every-row-not-the-cited-one.md`
 * (the fix-round-2 corrections below: §4's `deleteConversationTags`
 * dedup reverted to the un-narrowed Mongo sweep — F6; the surface table
 * re-derived to cover `createConversationTag`'s TWO interpolation sites
 * and `bulkIncrementTagCounts`'s caller-supplied tag list — F7;
 * DISCLOSED CONSEQUENCE §9 rewritten to the true, route-traced
 * behaviour — F8)
 * AS FURTHER AMENDED by
 * `2026-09-17-SPEC-ADDENDUM-G-derive-the-surface-table-from-the-WIRE-not-from-reading.md`
 * (fix round 3 — the surface table is now GENERATED from a captured-wire
 * probe, `./wireProbe.spec.js`, not from reading; that probe's own
 * captured output found the fix-round-2 table still undercounted
 * `createConversationTag` at TWO surfaces when the real count is THREE —
 * `this.listOwn`'s query-string maxPosition scan was missing entirely —
 * and DISCLOSED CONSEQUENCES §10/§11 below are new), which WINS: this module writes NO read/fallthrough/owner-stamping/
 * undefined-key-guard/clobber-merge logic of its own — every one of
 * those lives in `../AuditTraceSovereignAdapter` and is proven there
 * ONCE. `../AuditTraceFiles` is the reference adopter this module
 * follows; `../AuditTraceChatProjects` is the pre-base sibling this
 * module deliberately does NOT copy.
 *
 * The `~/models` conversation-tag methods
 * (`packages/data-schemas/src/methods/conversationTag.ts`,
 * `createConversationTagMethods`) LibreChat calls for persistence,
 * backed by HTTP calls to the BFF `/console/conversation-tags/*` proxy
 * instead of Mongo, gated behind `AUDITTRACE_MEMORY_BACKEND=sovereign`
 * (`../AuditTraceMemory/config`).
 *
 * ============================================================
 * GROUND-THE-SURFACE ENUMERATION (set-equality)
 * ============================================================
 * `createConversationTagMethods(mongoose)` returns an object whose keys
 * are, by set-equality against the function body's own `return {...}`
 * statement (`packages/data-schemas/src/methods/conversationTag.ts`),
 * EXACTLY 7:
 *
 *   `getConversationTags`, `createConversationTag`,
 *   `updateConversationTag`, `deleteConversationTag`,
 *   `deleteConversationTags`, `bulkIncrementTagCounts`,
 *   `updateTagsForConversation`.
 *
 * The module ALSO exports one standalone function, `decrementTagCounts`,
 * which is NOT part of that return object and is imported directly by
 * `packages/data-schemas/src/methods/conversation.ts` (its
 * `deleteConvos`'s wave-reconciliation step) — never through `~/models`,
 * so it carries no `~/models`-level name for a binder to intercept and is
 * out of this chokepoint's reach by construction (grep:
 * `grep -rn "decrementTagCounts" packages/data-schemas/src` finds exactly
 * the one `import` + one call site, both inside `conversation.ts`, never
 * `require('~/models')`).
 *
 * **Every consumer of the 7 named methods, including `routes/`** (grep:
 * `grep -rn "getConversationTags\|createConversationTag\|
 * updateConversationTag\|deleteConversationTag\|deleteConversationTags\|
 * bulkIncrementTagCounts\|updateTagsForConversation" api/ packages/`,
 * excluding the defining/type files):
 *  - `api/server/routes/tags.js` — `getConversationTags`,
 *    `createConversationTag`, `updateConversationTag`,
 *    `deleteConversationTag`, `updateTagsForConversation`, ALL five
 *    destructured from `require('~/models')` (the chokepoint export).
 *  - `api/server/controllers/UserController.js:459` —
 *    `db.deleteConversationTags({ user: user.id })` (account deletion;
 *    `db` is `require('~/models')`).
 *  - `api/server/utils/import/importBatchBuilder.js` —
 *    `bulkIncrementTagCounts` destructured from `require('~/models')`
 *    (conversation-fork/import tag-count reconciliation).
 * No injected-`methods`-parameter caller and no direct
 * `createConversationTagMethods(...)` call outside
 * `packages/data-schemas/src/methods/index.ts` (the aggregator every
 * other domain's shim already found clean) exists for this domain
 * (grep: `grep -rn "createConversationTagMethods" api/ packages/` finds
 * only the aggregator's import + call). Every one of the three consumer
 * sites obtains its function reference from `require('~/models')`
 * AFTER `api/models/index.js` has already run `wrapModelMethods(...)`
 * once at module-evaluation time (the SAME ordering
 * `AuditTraceFiles`/`AuditTraceChatProjects`/`AuditTracePresets`/
 * `AuditTracePrompts` already rely on), so no module-load-time capture
 * pins a raw, unwrapped reference ahead of the chokepoint.
 *
 * ============================================================
 * WHAT IS WIRED, AND WHAT PART OF EACH METHOD (7 methods; every one
 * named; several disclose a narrower Mongo-native carve-out WITHIN an
 * otherwise-wired method rather than leaving the whole method unwired)
 * ============================================================
 *
 *  - **`getConversationTags`** — WIRED, whole. Own-scoped list via the
 *    base's `listOwn`, sorted by `position` ascending (the sovereign
 *    list endpoint orders newest-first by `updated_at_ms`; the Mongo
 *    method orders by `position`, so this domain re-sorts client-side
 *    before returning).
 *
 *  - **`createConversationTag`** — WIRED for the plain-catalog-write
 *    shape (create-or-return-existing, no conversation attach). DISCLOSED
 *    CONSEQUENCE §1 (whole-call Mongo carve-out) when
 *    `data.addToConversation && data.conversationId`.
 *
 *  - **`updateConversationTag`** — WIRED for a plain `description`-only
 *    change. DISCLOSED CONSEQUENCE §2 (whole-call Mongo carve-out) for a
 *    rename (`data.tag` set and different from the id) or a `position`
 *    change.
 *
 *  - **`deleteConversationTag`** — WIRED: deletes the caller's own
 *    sovereign row by id. DISCLOSED CONSEQUENCE §3 (a Mongo-side-effect
 *    gap, not a wiring carve-out): the historical `Conversation.tags`
 *    pull and sibling-position renumbering that ran alongside the Mongo
 *    delete are not reproduced.
 *
 *  - **`deleteConversationTags`** — WIRED for the one live call shape,
 *    `{user: <id>}` ("delete all of my own tags"). Any other filter
 *    shape defers to Mongo unchanged (DISCLOSED CONSEQUENCE §4).
 *
 *  - **`bulkIncrementTagCounts`** — WIRED: increments each of the
 *    caller's OWN sovereign tags found; tags not found sovereignly are
 *    forwarded, batched, to the Mongo function's OWN "existing tags
 *    only" semantics (a no-op for a tag absent from Mongo too — the same
 *    contract the un-migrated method already has).
 *
 *  - **`updateTagsForConversation`** — DISCLOSED-UNWIRED (not present in
 *    `methods` below, so `wrapModelMethods` never intercepts it; every
 *    call reaches raw Mongo regardless of the flag). DISCLOSED
 *    CONSEQUENCE §5 names why: a genuinely cross-domain, multi-row write
 *    (the `Conversation.tags` array on ONE store plus every affected
 *    tag's `count` on ANOTHER) that no single domain adapter, scoped to
 *    one BFF proxy, can compose from the base's per-domain primitives
 *    without re-introducing exactly the half-committed-write class the
 *    base exists to prevent (`lesson-sovereign-adapter-read-discipline-
 *    20260913`'s meta-lesson).
 *
 * ============================================================
 * DISCLOSED CONSEQUENCES (deploy-acceptance — stated, not hidden)
 * ============================================================
 *  1. **`createConversationTag(user, {..., addToConversation: true,
 *     conversationId})` is Mongo-native for the WHOLE call**, including
 *     the tag-catalog write, when a `conversationId` accompanies the
 *     bookmark-flow flag (`client/src/components/Bookmarks/
 *     BookmarkForm.tsx` defaults this to `true` whenever a
 *     conversationId is present — this IS the live "bookmark this
 *     conversation" path, not a rare corner). The Mongo function's own
 *     `Conversation.findOneAndUpdate({user, conversationId},
 *     {$addToSet: {tags: tag}})` step has no sovereign-side equivalent
 *     this domain's `/console/conversation-tags`-scoped proxy can reach
 *     (it would require calling into `AuditTraceConversations`'s own
 *     write path from within this domain, splitting one logical
 *     operation across two BFF calls with no shared transaction) — so
 *     the plain tag-catalog write is deferred alongside it rather than
 *     partially committing the tag sovereignly and the conversation
 *     attach on Mongo. **Restated by OUTCOME (2026-09-17 review reject
 *     F3 / ADDENDUM E R5):** the write still SUCCEEDS, but against
 *     MONGO, not the sovereign store — Mongo's own `createConversationTag`
 *     does its OWN `ConversationTag.findOne({user, tag})` idempotency
 *     check against MONGO, never the sovereign store, so if a sovereign
 *     tag of the SAME name already exists this call does not find or
 *     update it: it independently upserts a NEW, separate Mongo-side row
 *     of the same name, and the two can diverge (different `count`/
 *     `position`). `getConversationTags` (wired, sovereign-only) never
 *     merges in that Mongo-side row — a tag created via the bookmark flow
 *     is INVISIBLE to every sovereign read until it is re-saved through a
 *     plain (non-attaching) `createConversationTag` call, or created
 *     directly against `/console/conversation-tags`.
 *  2. **A tag RENAME (`data.tag` set, different from the id) or a
 *     `position` CHANGE is Mongo-native for the WHOLE
 *     `updateConversationTag` call.** A rename also propagates via
 *     `Conversation.updateMany({user, tags: oldTag}, {$set:
 *     {'tags.$': newTag}})` — the same cross-domain gap as §1. A
 *     `position` change renumbers EVERY sibling tag whose position falls
 *     between the old and new value in one Mongo `updateMany` — an
 *     atomic multi-row reorder this domain's per-tag HTTP primitives
 *     have no compare-and-swap or bulk-update equivalent for; composing
 *     it as N sequential `updateById` calls would leave a caller's tag
 *     order visibly inconsistent to a concurrent reader mid-sequence,
 *     with no rollback if a later call in the sequence failed.
 *     **Restated by OUTCOME (2026-09-17 review reject F3 / ADDENDUM E
 *     R5) — this is NOT "stays on the system that already performs it
 *     atomically"; for a sovereign-only tag NEITHER operation works at
 *     all:** the Mongo deferral target, `updateConversationTag`, does its
 *     own `ConversationTag.findOne({user, tag: oldTag})` lookup against
 *     MONGO (`packages/data-schemas/src/methods/conversationTag.ts`),
 *     finds nothing for a sovereign-only tag, and returns `null` —
 *     `routes/tags.js`'s `PUT /:tag` handler then answers **404 "Tag not
 *     found"**. So for a sovereign-only tag, rename and reposition are
 *     silently INOPERATIVE (not a value split-brain — a feature loss the
 *     caller experiences as a 404), and because `getConversationTags`
 *     sorts by `position`, that tag's ordering is FROZEN at its creation
 *     position for its whole lifetime.
 *  3. **A sovereign tag delete does not touch `Conversation.tags`
 *     membership or renumber siblings.** The un-migrated Mongo
 *     `deleteConversationTag` additionally pulled the deleted tag out of
 *     every conversation's `tags` array and shifted every sovereign-side
 *     sibling with a greater `position` down by one — both Mongo-only
 *     bookkeeping this domain's single-row `deleteById` does not
 *     reproduce. `count`/`position` are documented as caller-maintained
 *     by the orchestrator service itself
 *     (`services/console_conversation_tags.py`'s module docstring: "this
 *     service persists whatever the caller upserts for count
 *     ... position; it never independently recomputes"), so this is
 *     consistent with the sovereign store's own contract, not a
 *     regression introduced here — but a deleted tag's name can remain
 *     in a conversation's `tags` array until that conversation is next
 *     saved with an explicit tag list.
 *  4. **A `deleteConversationTags` filter other than exactly `{user:
 *     <id>}` defers to Mongo unchanged** — no live call site names any
 *     other shape today (the enumeration above), so this is the SAME
 *     "residual filter, no sovereign query surface for it" boundary
 *     `classifyFilter` already names for reads, restated for this
 *     domain's one write-by-filter method. **For the ONE wired `{user}`
 *     shape, the Mongo sweep that follows the sovereign one runs the
 *     ORIGINAL, UN-NARROWED `{user}` filter (2026-09-17 review reject F6
 *     / ADDENDUM F R2 — reverted from a fix-round-1 `tag: {$nin: ownTags}`
 *     narrowing that traded an over-count for an under-DELETE):** Mongo's
 *     `deleteConversationTags` is `ConversationTag.deleteMany(filter)`
 *     (`packages/data-schemas/src/methods/conversationTag.ts`), so
 *     narrowing the FILTER narrows the DELETE, not just the count — a
 *     §1-style same-named duplicate (a Mongo-side row left behind by the
 *     `addToConversation` bookmark-flow deferral) would have SURVIVED
 *     account deletion (`UserController.js:459`'s
 *     `db.deleteConversationTags({user: user.id})`, whose return value is
 *     discarded — the "double count" the narrowing fixed was never
 *     observed by any live caller). Consequence, disclosed rather than
 *     silently accepted: `sovereign.deletedCount + mongoCount` MAY
 *     over-count a §1-style duplicate by 1 per duplicated name (Mongo's
 *     own sweep still matches and deletes it, so nothing survives, but
 *     the returned total double-counts a tag the caller experiences as
 *     ONE name) — an inflated, purely informational number on a return
 *     value no live caller reads, accepted in preference to the
 *     under-delete the narrowing introduced. See
 *     `index.spec.js`'s "the un-narrowed Mongo sweep leaves no row behind"
 *     case for the real-`deleteMany`-semantics proof.
 *  5. **`updateTagsForConversation` stays 100% Mongo-native.** See the
 *     enumeration above for why. Consequence: a conversation that is
 *     itself sovereign but whose tags are edited via this route
 *     (`PUT /convo/:conversationId`) is read/written against Mongo's
 *     `Conversation` collection for THIS call only — `Conversation.
 *     findOne({user, conversationId})` finds nothing for a
 *     sovereign-only conversation, so the call throws "Conversation not
 *     found" for a conversation that exists only in the sovereign store.
 *     Named, not closed; a later WU that gives `AuditTraceConversations`
 *     a tags-array primitive this domain can call could close it without
 *     changing this domain's own scope.
 *  6. **The `{user}` own-list is bounded** at `LIST_PAGE_SIZE *
 *     LIST_MAX_PAGES` tags/user (the base's declared ceiling; a warning
 *     is logged when hit) — see the constants below.
 *  7. **`bulkIncrementTagCounts` has a partial-commit window (2026-09-17
 *     review reject F4 / ADDENDUM E R4 — the one reject class the base
 *     CANNOT close, because it lives in how THIS domain composes the
 *     base's primitives, not in any one primitive).** Each of the
 *     caller's OWN tags is incremented via an INDEPENDENT `updateById`
 *     round trip, and all of them run concurrently under one
 *     `Promise.all`. Mongo's original composes the same operation as a
 *     SINGLE `tenantSafeBulkWrite` call (one `updateOne` op per unique
 *     tag, `packages/data-schemas/src/methods/conversationTag.ts`'s
 *     `bulkIncrementTagCounts`), which commits every op or none —
 *     `packages/data-schemas/misc/ferretdb/bulkWrite.ferretdb.spec.ts`'s
 *     FLOW 3 (`bulkIncrementTagCounts (existing-only, deduped)`, ~line
 *     372) is the differential test documenting that ORIGINAL atomic
 *     behaviour; this domain's composition does not reproduce it. If any
 *     one round trip rejects (a non-404 BFF error, or a transport
 *     failure), `Promise.all` rejects immediately while OTHER in-flight
 *     increments may already have committed sovereignly. Consequence: a
 *     caller observing a rejected `bulkIncrementTagCounts` call CANNOT
 *     assume no tag was incremented — an unknown, non-deterministic
 *     subset (depending on completion order) may already have been.
 *  8. **`deleteConversationTags`'s `{user}` sweep has the SAME
 *     partial-commit shape (2026-09-17 review reject F4 / ADDENDUM E
 *     R4), across TWO stores.** The sovereign half (`deleteByIds`)
 *     issues its per-tag `DELETE`s sequentially and is not
 *     transactional: a failure partway leaves the tags deleted so far
 *     deleted and the rest untouched. The Mongo half then runs as a
 *     SEPARATE, later call with no shared transaction across either
 *     phase. Consequence: a caller observing a rejected
 *     `deleteConversationTags({user})` call cannot assume "all or
 *     nothing" — some of the caller's tags, in either store, may already
 *     be gone.
 *  9. **REWRITTEN 2026-09-17, fix round 2 (review reject F8 / ADDENDUM F
 *     R5) — the prior wording was wrong on both halves.**
 *
 *     **A tag whose name is exactly `.` or `..` CANNOT be created
 *     sovereignly through this fork at all.** `createConversationTag`'s
 *     impl performs an idempotency PRE-READ, `this.readOne(src.tag, ...)`,
 *     BEFORE it ever calls `this.create` — and `readOne` → `fetchRaw` →
 *     `callProxy({path: id})` interpolates `src.tag` into a URL PATH
 *     SEGMENT via the SAME `encodeTagPath` the F1 fix hardened, which
 *     refuses `.`/`..` with a 400 fail-closed, before any HTTP request is
 *     issued. `this.create`'s own JSON-body write is never reached for
 *     such a name (see the re-derived surface table in the fix-round-2
 *     build record for both interpolation sites). Through the ONE route
 *     consumer, `routes/tags.js`'s `POST /`, the thrown `SovereignMemoryError`
 *     is caught by that handler's generic `catch` and answered as
 *     **HTTP 500 `{"error": "Internal server error"}`** — the underlying
 *     400 status is never read by that handler.
 *
 *     **A `.`/`..`-named row CAN still exist sovereignly** — not created
 *     through this fork, but through the orchestrator's own
 *     `/console/conversation-tags` write path directly (its body-field
 *     validation does not refuse `.`/`..`) or carried over by a Mongo
 *     migration. For such a PRE-EXISTING row, *"only its by-id operations
 *     are affected" is false*: with `batchGet: null` for this domain,
 *     `deleteConversationTags({user})` — **the account-deletion sweep**,
 *     `UserController.js:459`'s `db.deleteConversationTags({user:
 *     user.id})` — resolves the caller's own tag ids via `deleteByIds` →
 *     `resolveByIds`'s per-id `fetchRaw` FAN-OUT (no batch-get route for
 *     this domain), and `fetchRaw` swallows ONLY a 404; the `.`/`..`
 *     segment's 400 propagates OUT of `resolveByIds`, out of
 *     `deleteByIds`, out of this method's `impl`. `UserController.js`'s
 *     call site has no `try/catch` around it, so the exception reaches
 *     `deleteUserController`'s outer `catch`, which restores the fenced
 *     schedule-suspension state and answers the WHOLE account-deletion
 *     request **HTTP 500 `{"message": "Something went wrong."}`** —
 *     `deleteUserById` is never reached; account deletion is aborted
 *     entirely, not partially, and there is no in-product way to remove
 *     the offending row afterward (`deleteConversationTag`'s own by-id
 *     delete throws the identical 400). The tag still appears in
 *     `getConversationTags`'s list output (list pagination never calls
 *     `encodeTagPath`). Not reachable through the LibreChat UI's tag
 *     editor today (no live call site NAMES a `.`/`..` tag) — the residual
 *     gap is the orchestrator's own direct-write path and Mongo-migration
 *     carryover, both outside this fork's control; named because the
 *     base's own "no absolutes without proof" discipline requires it, not
 *     because it is exercised by any live call site today.
 *  10. **NEW 2026-09-17, fix round 3 (ADDENDUM G "Also required").**
 *      `getConversationTags(user)` DISCARDS its caller-supplied `user` on
 *      the sovereign path. `classifyFilter({user}, ...)`
 *      (`../AuditTraceSovereignAdapter/filters.js`) only checks that
 *      `user` is a non-empty STRING to select the `own-list` shape — its
 *      own docstring names this explicitly ("this is NOT owner-key
 *      scoping — RLS scopes by the token regardless"); the rows actually
 *      served come from `this.listOwn(token)`, scoped by the CALLER'S OWN
 *      bearer token, never by the string value of `user`. **Disclosed and
 *      ACCEPTED, not treated as a bug:** the outcome is fail-SAFE, not
 *      fail-open — a caller naming another user's id receives their OWN
 *      tags, the same as if they had passed their own id. `routes/tags.js`'s
 *      `GET /` invokes this with `req.user.id` (the token's own subject),
 *      never a caller-supplied value, so no live caller can even present a
 *      different `user` through the public surface today; the discard is
 *      a defence-in-depth property of the base every migrated domain
 *      shares, not an exploitable gap this domain introduces.
 *  11. **NEW 2026-09-17, fix round 3 (ADDENDUM G "Also required" R5) —
 *      the status code a `importBatchBuilder.js` consumer's user sees for
 *      a `.`/`..` tag element, traced end to end.** A `.`/`..` element in
 *      `convo.tags` reaches `bulkIncrementTagCounts(user, tags)`
 *      (`api/server/utils/import/importBatchBuilder.js:198`) unfiltered —
 *      `isId` accepts any non-empty string — and this domain's `impl`
 *      maps it into `this.updateById('.'|'..', ...)` inside the method's
 *      `Promise.all`; `updateById`'s `fetchRaw` → `callProxy({path: id})`
 *      → `encodeTagPath` throws the 400 `SovereignMemoryError` BEFORE any
 *      network hop, rejecting that `Promise.all` immediately (DISCLOSED
 *      CONSEQUENCE §7's partial-commit window applies — a sibling
 *      increment may already have committed). That rejection is one of
 *      the THREE promises in `saveBatch()`'s own `Promise.all`
 *      (`importBatchBuilder.js:190-199`), whose `catch` logs and
 *      RE-THROWS the same error; `importConversations()`'s `catch`
 *      (`api/server/utils/import/importConversations.js:38-40`) logs and
 *      RE-THROWS again by design ("throw error all the way up so request
 *      does not return success"); `routes/convos.js`'s `POST /import`
 *      handler's `catch` checks `isContentFilterError(error)` first — a
 *      `SovereignMemoryError` is none of `ContentFilterError` /
 *      `ContentTraversalLimitError` / `UninspectableFileError`
 *      (`packages/api/src/middleware/contentFilter.ts`), so this is
 *      `false` — and falls through to the generic branch:
 *      **`res.status(500).send('Error processing file')`.** The user sees
 *      a bare **HTTP 500**, plain-text `"Error processing file"` — the
 *      same undifferentiated shape as DISCLOSED CONSEQUENCE §9's
 *      account-deletion trace; the underlying 400, and which tag caused
 *      it, is never surfaced.
 *
 * **Chokepoint:** this module exports ONLY its adapter + binders. The
 * sovereign-vs-Mongo decision stays in
 * `AuditTraceConversations/index.js::wrapModelMethods` (ONE call site in
 * `api/models/index.js`, ONE `AsyncLocalStorage`), which merges
 * `SOVEREIGN_METHOD_BINDERS` below into `ALL_SOVEREIGN_METHOD_BINDERS`.
 */

const { logger } = require('@librechat/data-schemas');
const { AuditTraceSovereignAdapter } = require('../AuditTraceSovereignAdapter');
const { callConsoleConversationTagsProxy } = require('./client');
const { tagUpsertBody, apiToTag } = require('./mapping');

/** DISCLOSED CONSEQUENCE §6: 100 x 20 = 2000 tags/user own-list ceiling. */
const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 20;

/** @param {unknown} v @returns {v is string} */
const isId = (v) => typeof v === 'string' && v.length > 0;

/** @param {unknown} v @returns {v is number} */
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * The description-only merge for `updateConversationTag`'s wired shape:
 * every OTHER field of the existing record is kept as-is; `description`
 * is overwritten only when the caller passed one (`undefined` means "no
 * change", matching the Mongo method's own `if (description !==
 * undefined)` guard).
 *
 * @param {Record<string, unknown>} existing
 * @param {{description?: string}} delta
 * @returns {Record<string, unknown>}
 */
function descriptionOnlyMerge(existing, delta) {
  const merged = { ...existing };
  if (delta && delta.description !== undefined) {
    merged.description = delta.description;
  }
  return merged;
}

/**
 * The count-increment merge for `bulkIncrementTagCounts`'s per-tag
 * sovereign write: `count` is bumped by exactly 1 (the Mongo bulk op's
 * `$inc: {count: 1}`, applied per unique tag — the raw method already
 * dedupes its input, and this domain's caller does too, see the impl).
 *
 * @param {Record<string, unknown>} existing
 * @returns {Record<string, unknown>}
 */
function incrementCountMerge(existing) {
  return {
    ...existing,
    count: (isNumber(existing.count) ? existing.count : 0) + 1,
  };
}

class AuditTraceConversationTagsAdapter extends AuditTraceSovereignAdapter {
  constructor() {
    super({
      domain: 'conversationTags',
      callProxy: callConsoleConversationTagsProxy,
      idField: 'tag',
      ownerField: 'user',
      fromApi: apiToTag,
      toApiBody: tagUpsertBody,
      batchGet: null,
      list: { pageSize: LIST_PAGE_SIZE, maxPages: LIST_MAX_PAGES },
      methods: {
        // Mongo: getConversationTags(user) — own-list, re-sorted by
        // `position` ascending (the sovereign list endpoint orders
        // newest-first by `updated_at_ms`).
        getConversationTags: {
          kind: 'read',
          arity: 1,
          emptyResult: [],
          async impl([user], ctx) {
            const items = await this.readByFilter(
              { [this.ownerField]: user },
              { ...ctx, fallback: () => ctx.mongoFn(user) },
            );
            return [...items].sort(
              (a, b) =>
                (isNumber(a.position) ? a.position : 0) - (isNumber(b.position) ? b.position : 0),
            );
          },
        },
        // Mongo: createConversationTag(user, data) — idempotent
        // create-or-return-existing (DISCLOSED CONSEQUENCE §1 for the
        // conversation-attach shape).
        createConversationTag: {
          kind: 'write',
          arity: 2,
          async impl([user, data], ctx) {
            const src = data || {};
            if (!isId(src.tag)) {
              return this.deferToMongo(ctx, [user, src]);
            }
            if (src.addToConversation && isId(src.conversationId)) {
              // DISCLOSED CONSEQUENCE §1 — the conversation-attach half
              // of this call has no sovereign-side equivalent this
              // domain's proxy can reach; deferring the whole call keeps
              // the tag-catalog write and the conversation attach in the
              // ONE system that can commit both together.
              return this.deferToMongo(ctx, [user, src]);
            }
            const existing = await this.readOne(src.tag, { ...ctx, fallback: async () => null });
            if (existing != null) {
              // Mongo's own idempotent no-op: return the existing tag
              // UNCHANGED, never overwrite its position/count/description.
              return existing;
            }
            const own = await this.listOwn(this.requireToken(ctx.token));
            const maxPosition = own.reduce(
              (max, item) => (isNumber(item.position) && item.position > max ? item.position : max),
              0,
            );
            return this.create(
              src.tag,
              {
                tag: src.tag,
                description: src.description,
                count: src.addToConversation ? 1 : 0,
                position: maxPosition + 1,
              },
              ctx,
            );
          },
        },
        // Mongo: updateConversationTag(user, oldTag, data) — a plain
        // description-only change is wired; a rename or position change
        // is Mongo-native for the whole call (DISCLOSED CONSEQUENCE §2).
        updateConversationTag: {
          kind: 'write',
          arity: 3,
          emptyResult: null,
          impl([user, oldTag, data], ctx) {
            const src = data || {};
            const isRename = isId(src.tag) && src.tag !== oldTag;
            const isReposition = src.position !== undefined;
            if (!isId(oldTag) || isRename || isReposition) {
              return this.deferToMongo(ctx, [user, oldTag, src]);
            }
            return this.updateById(oldTag, src, {
              ...ctx,
              merge: descriptionOnlyMerge,
              fallback: () => this.deferToMongo(ctx, [user, oldTag, src]),
            });
          },
        },
        // Mongo: deleteConversationTag(user, tag) — write-by-id
        // (DISCLOSED CONSEQUENCE §3 for the Mongo-side-effect gap).
        deleteConversationTag: {
          kind: 'write',
          arity: 2,
          impl([user, tag], ctx) {
            return this.deleteById(tag, {
              ...ctx,
              fallback: () => this.deferToMongo(ctx, [user, tag]),
            });
          },
        },
        // Mongo: deleteConversationTags(filter) — write-by-filter; only
        // the one live shape, {user}, is wired (DISCLOSED CONSEQUENCE §4
        // for any other shape).
        deleteConversationTags: {
          kind: 'write',
          arity: 1,
          emptyResult: 0,
          async impl([filter], ctx) {
            const keys =
              filter && typeof filter === 'object' && !Array.isArray(filter)
                ? Object.keys(filter)
                : [];
            const ownerValue =
              filter && typeof filter === 'object' ? filter[this.ownerField] : undefined;
            const isDeleteAllMine =
              keys.length === 1 && keys[0] === this.ownerField && isId(ownerValue);
            if (!isDeleteAllMine) {
              return this.deferToMongo(ctx, [filter]);
            }
            const sub = this.currentSub();
            if (sub != null && String(ownerValue) !== String(sub)) {
              logger.warn(
                '[AuditTraceConversationTags] deleteConversationTags({user}) named a user other ' +
                  "than the request subject — the caller's sovereign own-list is NOT swept " +
                  '(fail-closed); only the Mongo path runs for the named user',
              );
              const mongoCount = await this.deferToMongo(ctx, [filter]);
              return isNumber(mongoCount) ? mongoCount : 0;
            }
            const token = this.requireToken(ctx.token);
            const own = await this.listOwn(token);
            const ownTags = own.map((item) => item.tag).filter(isId);
            const sovereign = await this.deleteByIds(ownTags, {
              token,
              fallback: async () => ({ deletedCount: 0 }),
            });
            // REVERTED 2026-09-17, fix round 2 (review reject F6 / ADDENDUM
            // F R2): the Mongo sweep runs the ORIGINAL, un-narrowed `filter`
            // — see DISCLOSED CONSEQUENCE §4 for why. Mongo's own
            // `deleteConversationTags` is `ConversationTag.deleteMany(filter)`
            // (`packages/data-schemas/src/methods/conversationTag.ts`); a
            // fix-round-1 `tag: {$nin: ownTags}` narrowing "fixed" an
            // unobserved over-count by instructing Mongo NOT TO DELETE a
            // §1-style duplicate — an under-delete on the account-deletion
            // path (`UserController.js:459`), which discards this return
            // value and would never have seen the over-count it fixed. The
            // un-narrowed sweep MAY over-count a duplicate name by 1 in the
            // returned total; nothing is left undeleted.
            const mongoCount = await this.deferToMongo(ctx, [filter]);
            return sovereign.deletedCount + (isNumber(mongoCount) ? mongoCount : 0);
          },
        },
        // Mongo: bulkIncrementTagCounts(user, tags) — increments each of
        // the caller's OWN sovereign tags found; tags not found
        // sovereignly are forwarded, batched, to the raw Mongo function
        // (its own "existing tags only" no-op semantics apply to those).
        bulkIncrementTagCounts: {
          kind: 'write',
          arity: 2,
          async impl([user, tags], ctx) {
            const unique = Array.isArray(tags) ? [...new Set(tags.filter(isId))] : [];
            if (unique.length === 0) {
              return undefined;
            }
            const missing = [];
            await Promise.all(
              unique.map(async (tag) => {
                const updated = await this.updateById(
                  tag,
                  {},
                  {
                    ...ctx,
                    merge: incrementCountMerge,
                    fallback: async () => null,
                  },
                );
                if (updated == null) {
                  missing.push(tag);
                }
              }),
            );
            if (missing.length > 0) {
              await this.deferToMongo(ctx, [user, missing]);
            }
            return undefined;
          },
        },
        // `updateTagsForConversation` is intentionally ABSENT — see the
        // module docstring's "DISCLOSED-UNWIRED" section and DISCLOSED
        // CONSEQUENCE §5. Every call reaches raw Mongo unconditionally;
        // `wrapModelMethods` only intercepts names present here.
      },
    });
  }
}

const conversationTagsAdapter = new AuditTraceConversationTagsAdapter();

/**
 * The conversation-tags domain's contribution to the ONE chokepoint —
 * built by the base (fixed arities, `(token, mongoFn, mongoMethods)`
 * signature), merged into `ALL_SOVEREIGN_METHOD_BINDERS` by
 * `AuditTraceConversations/index.js`.
 */
const SOVEREIGN_METHOD_BINDERS = conversationTagsAdapter.buildBinders();

module.exports = {
  AuditTraceConversationTagsAdapter,
  conversationTagsAdapter,
  SOVEREIGN_METHOD_BINDERS,
  LIST_PAGE_SIZE,
  LIST_MAX_PAGES,
};
