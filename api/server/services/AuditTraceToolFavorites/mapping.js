/**
 * Pure LibreChat <-> `/console/tool-favorites` field mapping (MongoDB-
 * elimination EPIC, Tool-Favorites domain — folded behind
 * `AuditTraceSovereignAdapter`). No I/O, no token — kept separate from
 * `index.js`, mirroring `AuditTraceConversationTags/mapping.js`'s split.
 *
 * **Naming differs across the boundary.** LibreChat's Mongo shape
 * (`packages/data-schemas/src/types/favorite.ts`) is camelCase
 * (`itemType`/`itemId`); the orchestrator's `ConsoleToolFavoriteItem`
 * (`src/audittrace/models.py`) is snake_case (`item_type`/`item_id`) plus
 * `tenant_id`/`metadata`/the three timestamp columns. This module is the
 * ONE place that translates between them.
 *
 * **The composite key.** Uniqueness is `(user, item_type, item_id)` —
 * there is no scalar `id`. `compositeKey` (`deriveCompositeKey`) is a
 * DERIVED, OPAQUE string this domain uses only to satisfy the base's
 * `idField` config contract (a non-empty-string identity token for
 * `create`'s required `id` parameter) — it is NEVER parsed back into its
 * parts anywhere in this domain (see `index.js`'s module docstring): the
 * real `itemType`/`itemId` always travel as their own, independently
 * validated fields through every `impl`, so there is no code path that
 * could mis-split an adversarial `itemId` back into the wrong `itemType`.
 * It is still proven collision-free below (`mapping.spec.js`) because the
 * base's config contract treats `idField` as an identity, and a future
 * consumer might reasonably rely on that: two DISTINCT
 * `(itemType, itemId)` pairs never derive the same `compositeKey`, given
 * `itemType` is always drawn from the closed `FAVORITE_ITEM_TYPES`
 * vocabulary BEFORE a key is ever derived (`index.js`'s `isValidItemType`
 * gate runs first) — none of the four enum literals is a colon-terminated
 * prefix of another, so the string `${itemType}:${itemId}` uniquely
 * determines both halves even when `itemId` itself contains the `:`
 * separator.
 *
 * **Owner fields are NOT this module's job.** `apiToFavorite` emits NO
 * `user`: the base's `toDomain` stamps `user` (the authenticated
 * request's subject) and `user_sub` on every record — request-derived,
 * never caller-supplied (the base's invariant 6). `favoriteAddBody`
 * likewise emits no owner field; the base strips any that slip through.
 *
 * **`tenant_id`/`metadata` are accepted by the orchestrator but never
 * sent by this domain.** The fork's `ToolFavoriteParams` (`addToolFavorite`
 * /`removeToolFavorite`) never carries either field — `favoriteAddBody`
 * omits them so the server applies its own declared defaults
 * (`tenant_id: null`, `metadata: {}}`), rather than this module inventing
 * values the fork's own contract has no concept of.
 */

const FAVORITE_KEY_SEPARATOR = ':';

/**
 * The lean projection LibreChat's own Mongo `getToolFavorites` returns
 * (`.select('itemType itemId -_id')`) — EXACTLY these two fields, no
 * `user_sub`/timestamps/`compositeKey` leaking into a caller's own
 * favorites list. `index.js`'s `getToolFavorites` impl trims to this
 * shape explicitly after the base's read discipline runs (the base's
 * `toDomain` stamps extra identity fields on every record; superset
 * output is the base's own documented invariant 5, but a favorites LIST
 * response is user-facing JSON, not a route needing a second field the
 * first read excluded, so this domain trims rather than leaking its own
 * internal bookkeeping fields to the client).
 *
 * @param {{itemType: unknown, itemId: unknown}} item
 * @returns {{itemType: string, itemId: string}}
 */
function toLeanFavorite(item) {
  return { itemType: item.itemType, itemId: item.itemId };
}

/**
 * Derives the OPAQUE composite-key string for a `(itemType, itemId)`
 * pair. See the module docstring for the collision-freedom argument.
 * Callers MUST validate `itemType` against the closed vocabulary BEFORE
 * calling this — the argument holds only when they do.
 *
 * @param {string} itemType
 * @param {string} itemId
 * @returns {string}
 */
function deriveCompositeKey(itemType, itemId) {
  return `${itemType}${FAVORITE_KEY_SEPARATOR}${itemId}`;
}

/**
 * Maps a `ConsoleToolFavoriteItem` response row onto the LibreChat
 * `IToolFavorite`-ish shape — MINUS the owner field (the base stamps it;
 * see the module docstring). Carries `compositeKey` for `index.js`'s own
 * in-process existence checks (`listOwn`-based, see that module's
 * docstring for why); NOT part of the fork's own type surface, and
 * trimmed away before any list response leaves this domain
 * (`toLeanFavorite`).
 *
 * @param {Record<string, unknown>} item
 * @returns {Record<string, unknown>}
 */
function apiToFavorite(item) {
  return {
    itemType: item.item_type,
    itemId: item.item_id,
    compositeKey: deriveCompositeKey(String(item.item_type), String(item.item_id)),
  };
}

/**
 * Builds the `ConsoleToolFavoriteAddRequest` body from an ALREADY-valid
 * `{itemType, itemId}` pair. Emits NO owner field, NO `tenant_id`/
 * `metadata` (see the module docstring).
 *
 * @param {string} _id - the base's required non-empty-string id
 *   parameter (the derived `compositeKey`) — unused: `itemType`/`itemId`
 *   travel as their own fields in `data`, never reconstructed from `_id`.
 * @param {{itemType: string, itemId: string}} data
 * @returns {Record<string, unknown>}
 */
function favoriteAddBody(_id, data) {
  const src = data || {};
  return {
    item_type: src.itemType,
    item_id: src.itemId,
  };
}

module.exports = {
  FAVORITE_KEY_SEPARATOR,
  toLeanFavorite,
  deriveCompositeKey,
  apiToFavorite,
  favoriteAddBody,
};
