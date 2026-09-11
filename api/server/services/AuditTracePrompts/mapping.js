/**
 * Pure LibreChat <-> `/console/prompts` field mapping (MongoDB-elimination
 * WU-prompts). No I/O, no token — kept separate from `index.js` so the
 * shape translation is independently testable, mirroring
 * `AuditTracePresets/mapping.js`'s split.
 *
 * **Group/version shape.** `ConsolePromptGroupItem`/`ConsolePromptVersionItem`
 * (`services/console_prompts.py` in AuditTrace-AI) have first-class columns
 * for `name`/`category`/`oneliner`/`command`/`production_prompt_id` (group)
 * and `text`/`type`/`version` (version), plus a generic `metadata` bag on
 * both. LibreChat's `IPromptGroup` additionally carries `numberOfGenerations`
 * (a usage counter), `author`/`authorName` (identity fields with no
 * sovereign-API first-class column — the sovereign store is already
 * single-owner/RLS-isolated, so `author` is implicit in WHO can read the
 * row, but LibreChat's OWN response shapes still expect the field to be
 * present) — these three fields round-trip through `metadata`, the SAME
 * "no first-class column -> generic bag" discipline
 * `AuditTracePresets/mapping.js`'s `data` bag uses, just for a handful of
 * named fields here rather than the whole preset config.
 *
 * **`metadata` is a FULL REPLACE on the server, not a merge**
 * (`services/console_prompts.py::upsert_group`/`upsert_version`: the row's
 * `metadata_json` is only touched `if metadata is not None`, but the
 * request model's `metadata: dict[str, Any] = Field(default_factory=dict)`
 * is NEVER `None` — an omitted `metadata` key in the JSON body still
 * arrives as `{}` server-side, which WOULD wipe `numberOfGenerations`/
 * `author`/`authorName` on every group write that doesn't explicitly
 * re-send them). `index.js` avoids this the SAME way
 * `AuditTracePresets/index.js::savePreset` avoids it for `data`: every
 * group/version write in `index.js` fetches the EXISTING row first and
 * builds its `metadata` argument from the merged result BEFORE calling
 * this module's `groupUpsertBody`/`versionUpsertBody` — this module never
 * merges itself (kept pure/synchronous, no I/O).
 */

/** @param {unknown} v @returns {boolean} */
function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Builds the `ConsolePromptGroupUpsertRequest` body. `metadata` MUST be
 * the already-merged bag (see this module's docstring) — this function
 * never merges it itself.
 *
 * @param {string} groupId
 * @param {{name: string, category?: string|null, oneliner?: string|null,
 *   command?: string|null, metadata: Record<string, unknown>}} fields
 * @returns {Record<string, unknown>}
 */
function groupUpsertBody(groupId, { name, category, oneliner, command, metadata }) {
  return {
    group_id: groupId,
    name,
    category: category ?? undefined,
    oneliner: oneliner ?? undefined,
    command: command ?? undefined,
    metadata: metadata || {},
  };
}

/**
 * Builds the `ConsolePromptVersionUpsertRequest` body. `metadata` MUST be
 * the already-merged bag (see this module's docstring).
 *
 * @param {string} promptId
 * @param {{text: string, type?: string, metadata?: Record<string, unknown>}} fields
 * @returns {Record<string, unknown>}
 */
function versionUpsertBody(promptId, { text, type, metadata }) {
  return {
    prompt_id: promptId,
    text,
    type: type === 'chat' ? 'chat' : 'text',
    metadata: metadata || {},
  };
}

/**
 * Maps a `ConsolePromptGroupItem` (with or without `versions` — the
 * `versions` key, if present, is ignored here; callers needing the
 * `productionPrompt` shape build it themselves from the raw item's
 * `versions`, since that requires cross-referencing
 * `production_prompt_id`) onto the LibreChat `IPromptGroup` shape.
 *
 * @param {Record<string, unknown>} item
 * @returns {Record<string, unknown>}
 */
function apiToGroup(item) {
  const metadata = isPlainObject(item.metadata) ? item.metadata : {};
  return {
    _id: item.group_id,
    name: item.name,
    numberOfGenerations:
      typeof metadata.numberOfGenerations === 'number' ? metadata.numberOfGenerations : 0,
    oneliner: item.oneliner,
    category: item.category,
    productionId: item.production_prompt_id ?? null,
    author: metadata.author,
    authorName: metadata.authorName,
    command: item.command ?? undefined,
    createdAt: new Date(item.created_at_ms).toISOString(),
    updatedAt: new Date(item.updated_at_ms).toISOString(),
  };
}

/**
 * Maps a `ConsolePromptVersionItem` onto the LibreChat `IPrompt` shape.
 *
 * @param {Record<string, unknown>} item
 * @returns {Record<string, unknown>}
 */
function apiToVersion(item) {
  const metadata = isPlainObject(item.metadata) ? item.metadata : {};
  return {
    _id: item.prompt_id,
    groupId: item.group_id,
    author: metadata.author,
    prompt: item.text,
    type: item.type,
    createdAt: new Date(item.created_at_ms).toISOString(),
    updatedAt: new Date(item.updated_at_ms).toISOString(),
  };
}

module.exports = {
  isPlainObject,
  groupUpsertBody,
  versionUpsertBody,
  apiToGroup,
  apiToVersion,
};
