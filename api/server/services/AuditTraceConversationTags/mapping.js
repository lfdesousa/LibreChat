/**
 * Pure LibreChat <-> `/console/conversation-tags` field mapping
 * (MongoDB-elimination EPIC, Conversation-Tags domain — folded behind
 * `AuditTraceSovereignAdapter`). No I/O, no token — kept separate from
 * `index.js` so the shape translation is independently testable,
 * mirroring `AuditTraceFiles/mapping.js`'s split.
 *
 * **Shape.** `ConsoleConversationTagItem`
 * (`src/audittrace/models.py` in AuditTrace-AI) has first-class columns
 * for `tag`/`description`/`count`/`position` plus `created_at_ms`/
 * `updated_at_ms`/`deleted_at_ms` and a generic `metadata` bag. LibreChat's
 * Mongo `IConversationTag`
 * (`packages/data-schemas/src/methods/conversationTag.ts`) has
 * `user`/`tag`/`description`/`position`/`count`/`createdAt` plus the
 * Mongoose-added `_id`/`__v`. There is no field this module needs to
 * round-trip through `metadata` — every LibreChat field the model
 * methods read (`tag`, `description`, `position`, `count`, `createdAt`)
 * has a first-class sovereign column.
 *
 * **`_id` on a sovereign record IS its `tag` (a string), by design** —
 * the SAME discipline `AuditTraceFiles/mapping.js` documents for
 * `file_id`. No live caller reads a conversation-tag's `_id` as an
 * ObjectId (`routes/tags.js` only ever serializes the whole object to
 * JSON), so a string satisfies every downstream use.
 *
 * **Owner fields are NOT this module's job.** `apiToTag` emits NO
 * `user`: the base's `toDomain` stamps `user` (the authenticated
 * request's subject, from the ONE `AsyncLocalStorage`) and `user_sub`
 * (the store's own value, when present) on every record — request-
 * derived, never caller-supplied, never mapping-supplied (the base's
 * invariant 6). `tagUpsertBody` likewise emits no owner field; the base
 * strips any that slip through, and the server derives the owner from
 * the bearer token.
 *
 * **`count` is clamped to a non-negative integer.** The orchestrator's
 * `ConsoleConversationTagUpsertRequest.count` is `Field(ge=0)` — a
 * caller-computed decrement (`bulkIncrementTagCounts`'s sibling,
 * `decrementTagCounts`, is Mongo-only and out of this domain's reach —
 * see `index.js`'s disclosed consequences) could otherwise send a
 * negative delta and 422 the whole upsert; this module clamps at the
 * boundary instead of letting a transport-level validation error surface
 * as an opaque `SovereignMemoryError`.
 *
 * **`data` on the server REPLACES the row's non-key columns wholesale**
 * (`services/console_conversation_tags.py::upsert_conversation_tag` sets
 * `row.count`/`row.position` unconditionally, `row.description` only
 * when the caller passed one). The base's `updateById` fetches the
 * EXISTING row first and merges the delta on top before ever calling
 * `tagUpsertBody` (its invariant 8) — this module only builds a body
 * from an ALREADY-merged object; it never merges itself.
 */

/** @param {unknown} v @returns {v is number} */
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Builds the `ConsoleConversationTagUpsertRequest` body from an
 * ALREADY-merged LibreChat-shaped conversation-tag object. Emits NO
 * owner field.
 *
 * @param {string} tag
 * @param {Record<string, unknown>} data
 * @returns {Record<string, unknown>}
 */
function tagUpsertBody(tag, data) {
  const src = data || {};
  return {
    tag,
    description: typeof src.description === 'string' ? src.description : undefined,
    count: Math.max(0, isFiniteNumber(src.count) ? Math.trunc(src.count) : 0),
    position: isFiniteNumber(src.position) ? Math.trunc(src.position) : 0,
    metadata: {},
  };
}

/**
 * Maps a `ConsoleConversationTagItem` response row onto the LibreChat
 * `IConversationTag` shape — MINUS the owner field, which the base
 * stamps (see the module docstring). `_id` is the `tag` (see the module
 * docstring).
 *
 * @param {Record<string, unknown>} item
 * @returns {Record<string, unknown>}
 */
function apiToTag(item) {
  return {
    _id: item.tag,
    tag: item.tag,
    description: typeof item.description === 'string' ? item.description : undefined,
    position: isFiniteNumber(item.position) ? item.position : 0,
    count: isFiniteNumber(item.count) ? item.count : 0,
    createdAt: typeof item.created_at_ms === 'number' ? new Date(item.created_at_ms) : undefined,
  };
}

module.exports = {
  isFiniteNumber,
  tagUpsertBody,
  apiToTag,
};
