/**
 * Pure LibreChat <-> `/console/file-records` field mapping (MongoDB-
 * elimination EPIC, Files domain — the REFERENCE adopter of
 * `AuditTraceSovereignAdapter`). No I/O, no token — kept separate from
 * `index.js` so the shape translation is independently testable,
 * mirroring `AuditTraceChatProjects/mapping.js`'s split.
 *
 * **Shape.** `ConsoleFileItem` (`services/console_files.py` in
 * AuditTrace-AI) has first-class columns for `file_id`/`filename`/`type`/
 * `bytes`/`object_key`/`width`/`height`/`context`/`usage`/`embedded`/
 * `temp_file_id` plus a generic `metadata` bag. LibreChat's Mongo
 * `IMongoFile` (`packages/data-schemas/src/types/file.ts`) carries several
 * MORE fields with no sovereign first-class column — `source`, `filepath`,
 * `storageRegion`, `text`, `textFormat`, `status`, `previewError`,
 * `previewRevision`, `conversationId`, `messageId`, `model`, `tenantId` —
 * these round-trip through `metadata` verbatim (the SAME escape valve
 * `AuditTraceConversations`'s own `metadata` bag uses), never silently
 * dropped.
 *
 * **`usage` is a type mismatch, deliberately bridged, not ignored.** Mongo's
 * `usage` is a plain incrementing `Number`; the sovereign `usage` column is
 * a generic `dict[str, Any]`. This module stores the Mongo counter as
 * `{count: <number>}` — a disclosed, deliberate bridge.
 *
 * **`object_key` mirrors Mongo's `storageKey`; `filepath` does NOT
 * round-trip as a live value.** `storageKey` is the STABLE S3 object key
 * (uploader-namespaced — see `index.js`'s "S3 isolation finding");
 * `filepath` is a TIME-LIMITED signed URL Mongo's own `batchUpdateFiles`
 * reaper periodically re-signs, and that reaper stays Mongo-native
 * (`index.js`'s disclosure). `filepath` is round-tripped through
 * `metadata.filepath` as an HONEST "last known value at write time" — a
 * disclosed staleness gap, not papered over.
 *
 * **`_id` on a sovereign record IS its `file_id` (a string), by design.**
 * `routes/files/files.js`'s text-download route re-fetches the authorized
 * record by `{_id: file._id}` to read the `text` column `getFiles`
 * excludes by default. An earlier revision emitted NO `_id`, so that
 * re-fetch became `{_id: undefined}` → Mongoose stripped it → the WHOLE
 * `File` collection → another user's text (reviewer F6, a SECURITY
 * reject). Now: (a) the base short-circuits any undefined-keyed filter
 * regardless (its invariant 4), AND (b) `apiToFile` emits `_id =
 * file_id`, which the base treats as an id ALIAS (`index.js`'s
 * `idAliases: ['_id']`) — so the re-fetch is an id-shaped read served
 * from the caller's OWN sovereign record, `text` included, with Mongo
 * never consulted. A legacy Mongo record keeps its real ObjectId `_id`,
 * which the base recognizes as defined-and-Mongo-native (deferred
 * unchanged). Downstream consumers only ever `.toString()` it
 * (`packages/api/src/skills/handlers.ts`), which a string satisfies.
 *
 * **Owner fields are NOT this module's job.** `apiToFile` emits NO
 * `user`: the base's `toDomain` stamps `user` (the authenticated
 * request's subject, from the ONE `AsyncLocalStorage`) and `user_sub`
 * (the store's own value) on every record — request-derived, never
 * caller-supplied, never mapping-supplied (the base's invariant 6, the
 * files-v2 F3 class). `fileUpsertBody` likewise emits no owner field; the
 * base strips any that slip through, and the server derives the owner
 * from the bearer token.
 *
 * **`data` is a FULL REPLACE of `metadata` on the server, not a merge**
 * (`services/console_files.py::upsert_file`). The base's `updateById`
 * fetches the EXISTING row first and merges the delta on top before ever
 * calling `fileUpsertBody` (its invariant 8) — this module only builds a
 * body from an ALREADY-merged object; it never merges itself.
 */

/** @param {unknown} v @returns {boolean} */
function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * LibreChat-only fields with no sovereign first-class column — round-
 * tripped through the generic `metadata` bag verbatim.
 */
const METADATA_ONLY_FIELDS = [
  'source',
  'filepath',
  'storageRegion',
  'text',
  'textFormat',
  'status',
  'previewError',
  'previewRevision',
  'conversationId',
  'messageId',
  'model',
  'tenantId',
];

/**
 * Builds the `metadata` bag from an ALREADY-merged LibreChat-shaped file
 * object. `undefined` values are dropped (never sent as an explicit
 * `null` overwrite).
 *
 * @param {Record<string, unknown>} data
 * @returns {Record<string, unknown>}
 */
function fileExtraMetadata(data) {
  const metadata = {};
  const src = data || {};
  for (const key of METADATA_ONLY_FIELDS) {
    if (src[key] !== undefined) {
      metadata[key] = src[key];
    }
  }
  return metadata;
}

/**
 * Builds the `ConsoleFileUpsertRequest` body from an ALREADY-merged
 * LibreChat-shaped file object. Emits NO owner field.
 *
 * @param {string} fileId
 * @param {Record<string, unknown>} data
 * @returns {Record<string, unknown>}
 */
function fileUpsertBody(fileId, data) {
  const src = data || {};
  return {
    file_id: fileId,
    filename: typeof src.filename === 'string' ? src.filename : '',
    type: typeof src.type === 'string' ? src.type : 'application/octet-stream',
    bytes: typeof src.bytes === 'number' ? src.bytes : 0,
    object_key: typeof src.storageKey === 'string' ? src.storageKey : undefined,
    width: typeof src.width === 'number' ? src.width : undefined,
    height: typeof src.height === 'number' ? src.height : undefined,
    context: typeof src.context === 'string' ? src.context : undefined,
    usage: { count: typeof src.usage === 'number' ? src.usage : 0 },
    embedded: !!src.embedded,
    temp_file_id: typeof src.temp_file_id === 'string' ? src.temp_file_id : undefined,
    metadata: fileExtraMetadata(src),
  };
}

/**
 * Maps a `ConsoleFileItem` response row onto the LibreChat `IMongoFile`
 * shape — MINUS the owner fields, which the base stamps (see the module
 * docstring). `_id` is the `file_id` (see the module docstring).
 *
 * @param {Record<string, unknown>} item
 * @returns {Record<string, unknown>}
 */
function apiToFile(item) {
  const metadata = isPlainObject(item.metadata) ? item.metadata : {};
  const usage = isPlainObject(item.usage) ? item.usage : {};
  return {
    _id: item.file_id,
    file_id: item.file_id,
    filename: item.filename,
    filepath: typeof metadata.filepath === 'string' ? metadata.filepath : '',
    storageKey: item.object_key || undefined,
    storageRegion: metadata.storageRegion,
    object: 'file',
    embedded: !!item.embedded,
    type: item.type,
    context: item.context ?? undefined,
    usage: typeof usage.count === 'number' ? usage.count : 0,
    source: typeof metadata.source === 'string' ? metadata.source : 'local',
    model: metadata.model,
    width: typeof item.width === 'number' ? item.width : undefined,
    height: typeof item.height === 'number' ? item.height : undefined,
    bytes: typeof item.bytes === 'number' ? item.bytes : 0,
    text: metadata.text,
    textFormat: metadata.textFormat,
    status: metadata.status,
    previewError: metadata.previewError,
    previewRevision: metadata.previewRevision,
    conversationId: metadata.conversationId,
    messageId: metadata.messageId,
    temp_file_id: item.temp_file_id || undefined,
    tenantId: metadata.tenantId,
    createdAt: new Date(item.created_at_ms),
    updatedAt: new Date(item.updated_at_ms),
  };
}

module.exports = {
  isPlainObject,
  METADATA_ONLY_FIELDS,
  fileExtraMetadata,
  fileUpsertBody,
  apiToFile,
};
