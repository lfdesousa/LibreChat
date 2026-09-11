/**
 * Pure LibreChat <-> `/console/presets` field mapping (MongoDB-elimination
 * WU-presets). No I/O, no token — kept separate from `index.js` so the
 * shape translation is independently testable, mirroring
 * `AuditTraceConversations/mapping.js`'s split.
 *
 * **`data` carries the WHOLE preset config bag.** Unlike conversations
 * (a handful of first-class columns + a `metadata` overflow bag),
 * `packages/data-schemas/src/schema/preset.ts`'s `IPreset` is almost
 * entirely an open-ended per-endpoint config object (`endpoint`, `model`,
 * `temperature`, `tools`, `promptPrefix`, `spec`, ... — dozens of
 * optional fields that vary by endpoint type, with NO fixed schema).
 * `ConsolePresetItem.data` (a generic `dict[str, Any]`,
 * `services/console_presets.py`) is built for exactly this: EVERY field
 * except `presetId`/`title` (which have first-class columns) and Mongo/
 * LibreChat plumbing (`user`, `_id`, `__v`, `tenantId`, `createdAt`,
 * `updatedAt` — server-assigned or identity fields with no sovereign-API
 * equivalent) round-trips through `data` verbatim, so no per-endpoint
 * preset field is ever silently dropped by this mapping layer merely for
 * lacking a named column (contrast conversations' documented `isArchived`/
 * `pinned`/`tags` v1 simplification — presets have no such gap because
 * `data` is unbounded).
 *
 * **`data` is a FULL REPLACE on the server, not a merge**
 * (`services/console_presets.py::upsert_preset`: `row.data = data`
 * unconditionally whenever `data is not None` — and the route always
 * passes a dict, never `None`). `index.js`'s `savePreset` avoids the
 * silent-data-loss shape this implies (the SAME class of bug WU-2b's
 * reviewer flagged for conversation `metadata`) by fetching the EXISTING
 * row first and merging the caller's delta on top of it before ever
 * calling `presetUpsertBody` — this module only builds a body from an
 * ALREADY-merged `rest` object; it never merges itself (kept pure/
 * synchronous, no I/O), mirroring `AuditTraceConversations/mapping.js`'s
 * own "never merges itself" discipline.
 */

/** @param {unknown} v @returns {boolean} */
function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Fields that map to a first-class column (`title`) or are Mongo/
 * LibreChat plumbing with no sovereign-API equivalent (`user`, `_id`,
 * `__v`, `tenantId`, `createdAt`, `updatedAt`) — never persisted inside
 * the `data` bag, so `title` has exactly ONE source of truth (the
 * top-level column) instead of silently drifting from a stale copy
 * inside `data`.
 */
const NON_DATA_FIELDS = new Set([
  'title',
  'user',
  '_id',
  '__v',
  'tenantId',
  'createdAt',
  'updatedAt',
]);

/**
 * Builds the `data` bag for a preset upsert from an ALREADY-merged
 * LibreChat-shaped preset object (the caller's delta merged onto the
 * existing row, per this module's docstring).
 *
 * @param {Record<string, unknown>} rest - every preset field except
 *   `presetId`/`newPresetId`/`defaultPreset` (already destructured out by
 *   the caller, mirroring Mongo's own `savePreset` destructure) and the
 *   `NON_DATA_FIELDS` above.
 * @returns {Record<string, unknown>}
 */
function presetDataFields(rest) {
  const data = {};
  for (const [key, value] of Object.entries(rest || {})) {
    if (NON_DATA_FIELDS.has(key) || value === undefined) {
      continue;
    }
    data[key] = value;
  }
  return data;
}

/**
 * Maps a `(presetId, title, data)` triple onto
 * `ConsolePresetUpsertRequest`'s shape.
 *
 * @param {string} presetId
 * @param {string|undefined} title
 * @param {Record<string, unknown>} data - the FULL data bag to persist
 *   (already merged with the existing row by the caller — see this
 *   module's docstring).
 * @returns {Record<string, unknown>}
 */
function presetUpsertBody(presetId, title, data) {
  return {
    preset_id: presetId,
    title: typeof title === 'string' && title.length > 0 ? title : 'New Chat',
    data: data || {},
  };
}

/**
 * Maps a `ConsolePresetItem` response row back onto the LibreChat-shaped
 * preset object callers expect from `getPreset`/`getPresets`/
 * `savePreset`.
 *
 * @param {Record<string, unknown>} item
 * @param {string} [userId]
 * @returns {Record<string, unknown>}
 */
function apiToPreset(item, userId) {
  const data = isPlainObject(item.data) ? item.data : {};
  return {
    ...data,
    presetId: item.preset_id,
    title: item.title,
    user: userId,
    createdAt: new Date(item.created_at_ms).toISOString(),
    updatedAt: new Date(item.updated_at_ms).toISOString(),
  };
}

module.exports = {
  isPlainObject,
  presetDataFields,
  presetUpsertBody,
  apiToPreset,
};
