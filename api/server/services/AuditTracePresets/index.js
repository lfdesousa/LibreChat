/**
 * The sovereign-presets adapter (MongoDB-elimination EPIC, WU-presets —
 * the FIRST reuse of the WU-2b model-layer-chokepoint pattern,
 * 2026-09-11) — the `~/models` preset methods
 * (`packages/data-schemas/src/methods/preset.ts`) LibreChat calls for
 * persistence, backed by HTTP calls to the BFF `/console/presets/*` proxy
 * instead of Mongo, gated behind `AUDITTRACE_MEMORY_BACKEND=sovereign`
 * (`../AuditTraceMemory/config`).
 *
 * **Reuses the WU-2b chokepoint, does not re-invent it.** This module
 * exports ONLY the four preset adapter functions + their
 * `SOVEREIGN_METHOD_BINDERS` map (below) — the actual "is this call
 * sovereign, is there a live token" DECISION still happens in exactly
 * ONE place, `AuditTraceConversations/index.js::wrapModelMethods`, which
 * merges this module's binders into its own before wrapping the
 * `createMethods(...)` output (see that module's docstring for the full
 * "why a single export-point chokepoint, not per-route wiring"
 * rationale — three route-level-wiring REJECTs, closed by the pivot).
 * There is deliberately NO second `AsyncLocalStorage`, NO second
 * "backend selected?" branch, and NO second call site in
 * `api/models/index.js` — `wrapModelMethods()` is still called EXACTLY
 * ONCE.
 *
 * **Ground-the-surface enumeration (build-record disclosure).** LibreChat's
 * `~/models` preset exports are `getPreset`, `getPresets`, `savePreset`,
 * `deletePresets` (`packages/data-schemas/src/methods/preset.ts`). Every
 * consumer obtains them via `require('~/models')`:
 *   - `api/server/routes/presets.js` — destructures `getPresets`,
 *     `savePreset`, `deletePresets` at module load. Wired by construction
 *     (same chokepoint export point as every other `~/models` consumer).
 *   - `api/server/controllers/UserController.js` — `const db =
 *     require('~/models')` at module load (the SAME injected-reference
 *     shape as the WU-2b `schedules.js` trap this WU was warned about),
 *     calling `db.deletePresets(user.id)` inside `deleteUserController`.
 *     Wired by construction: `db` IS the chokepoint's exported object: no
 *     name-based enumeration was needed to find this caller because the
 *     chokepoint covers it structurally, but it is named here for the
 *     disclosure record.
 *   - `getPreset` (singular) has NO current caller anywhere in the fork
 *     (grepped exhaustively — routes, controllers, services, utils/import,
 *     client). Wired anyway (bound in `SOVEREIGN_METHOD_BINDERS` below)
 *     for parity with the other three methods and because the chokepoint
 *     costs nothing extra to cover an unused export; a future caller
 *     inherits sovereign routing automatically.
 *   - No injected-`methods`-param caller exists for ANY preset method
 *     (`services/Schedules/index.js` only threads `getChatProject`/
 *     `isAgentTriggerPrincipalActive`; `utils/import/fork.js` and
 *     `importBatchBuilder.js` touch conversations/messages only, never
 *     presets) — grepped for `methods\.(getPreset|getPresets|savePreset|
 *     deletePresets)` and `\.(getPreset|getPresets|savePreset|
 *     deletePresets)\(` across the whole fork; the two call sites above
 *     are the complete set. There is therefore no disclosed
 *     "background/no-token" preset-write category (Lesson 4) distinct
 *     from the one general boundary the chokepoint itself already
 *     documents (`AuditTraceConversations/index.js`'s "one honest,
 *     disclosed boundary").
 *
 * **Module-load-time capture audit (Lesson 3).** `UserController.js`'s
 * `const db = require('~/models')` captures the EXPORTED OBJECT at module
 * load, not a snapshot of "which backend is active" — every property on
 * that object is already a call-time-dispatching wrapper (built once by
 * `wrapModelMethods`, which reads `isSovereignBackend()`/
 * `getRequestAccessToken()` freshly INSIDE the wrapper on every
 * invocation, not at wrap time). So `db.deletePresets(...)`, called
 * whenever `deleteUserController` eventually runs, still resolves against
 * the CURRENT flag + CURRENT request's token, exactly like a route that
 * destructures fresh on every `require('~/models')` call (Node's module
 * cache makes the two shapes equivalent). No separate ownership/
 * validation module rebuilds a preset-specific Mongo binding at load time
 * (unlike the `messageValidation.js` trap this Lesson warns about) — grepped
 * for `require\(.~/models.\)` and preset-shaped destructures across
 * `api/server/middleware/` and found none.
 *
 * **Fail-closed, always.** A non-2xx from `callConsolePresetsProxy`
 * (`SovereignMemoryError`) propagates to the caller unchanged — no method
 * here ever falls back to a Mongo call on error. The one place a
 * `SovereignMemoryError` is deliberately interpreted rather than
 * re-thrown is a 404 read (an absent/foreign preset), which maps to
 * `null`/fan-out-tolerant-skip — the SAME "not found" semantics Mongo's
 * own `getPreset`/`deletePresets` already have for a no-match query, not
 * a fail-open shortcut (no write path does this).
 *
 * **Data-clobber guard** (see `mapping.js`'s module docstring):
 * `savePreset` fetches the EXISTING row first and merges the caller's
 * delta on top of it before building the upsert body, so a save that
 * only carries a changed field (e.g. a bare `{presetId, defaultPreset:
 * true}` toggle) never wipes previously-saved config.
 *
 * **Disclosed v1 simplifications** (documented, not silent gaps):
 *   - The cross-row "only one default preset per user" invariant Mongo's
 *     `savePreset` enforces (unsetting any OTHER preset's
 *     `defaultPreset`/`order`) is NOT replicated here — this preset's own
 *     `defaultPreset`/`order` fields are set/unset correctly, but a
 *     previously-default OTHER preset is left marked default too. Closing
 *     this would need a full-collection scan on every default-toggle
 *     save (`collectAllPresets`, defined below, already exists for
 *     `getPresets`/`deletePresets`'s fan-out needs, so the primitive is
 *     available) — deferred as an explicit follow-up, not attempted here
 *     to keep this WU's surface to the ratified spec's CRUD scope.
 *   - `newPresetId` (a rename-on-save parameter Mongo's `savePreset`
 *     accepts) has NO live caller anywhere in the fork today (grepped).
 *     It is honored here (the upsert targets the new id), but — unlike
 *     Mongo's own `findOneAndUpdate`, which renames the SAME document —
 *     the OLD `presetId` row is left behind, not deleted. Zero behavioral
 *     risk today (no caller passes it); flagged for whoever wires a
 *     rename UI feature later.
 */

const { callConsolePresetsProxy } = require('./client');
const { isPlainObject, presetDataFields, presetUpsertBody, apiToPreset } = require('./mapping');
const { SovereignMemoryError } = require('../AuditTraceMemory/errors');

const COLLECT_ALL_PAGE_SIZE = 100;
const DEFAULT_ORDER = 10000;

/** @param {unknown} error @returns {boolean} */
function isNotFound(error) {
  return error instanceof SovereignMemoryError && error.status === 404;
}

/**
 * Fetches the raw (unmapped) `ConsolePresetItem` for one preset, or
 * `null` if it doesn't exist/isn't owned. Internal — used by `savePreset`
 * to merge `data` before an upsert (see the module docstring's
 * "Data-clobber guard"); callers needing the LibreChat-shaped object
 * should use `getPreset` instead.
 *
 * @param {string} presetId
 * @param {string|null|undefined} token
 * @returns {Promise<Record<string, unknown>|null>}
 */
async function fetchRawPresetItem(presetId, token) {
  try {
    return await callConsolePresetsProxy({ method: 'GET', path: presetId, token });
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Pages through `GET /console/presets` to collect every preset the
 * caller owns — used by `getPresets` (the sovereign API has no
 * single-request "list everything" call) and by `deletePresets`'s
 * "delete everything" (empty/absent filter) fan-out.
 *
 * @param {string|null|undefined} token
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function collectAllPresets(token) {
  const items = [];
  let cursor;
  for (;;) {
    const query = { limit: String(COLLECT_ALL_PAGE_SIZE) };
    if (cursor) {
      query.cursor = cursor;
    }
    const resp = await callConsolePresetsProxy({ method: 'GET', path: '', token, query });
    const pageItems = Array.isArray(resp && resp.items) ? resp.items : [];
    items.push(...pageItems);
    cursor = resp && resp.next_cursor;
    if (!cursor) {
      break;
    }
  }
  return items;
}

/**
 * Fetches the caller's own preset. Mirrors Mongo's
 * `getPreset(user, presetId)` signature with `token` appended. Returns
 * `null` on 404 — the SAME "not found or not owned" contract Mongo's
 * `getPreset` has for a no-match query (Mongo itself instead returns
 * `{message: '...'}` on an INTERNAL error, a legacy shape this adapter
 * does not replicate — a genuine error propagates loudly here, per the
 * module docstring's fail-closed discipline).
 *
 * @param {string} user
 * @param {string} presetId
 * @param {string|null|undefined} token
 * @returns {Promise<Record<string, unknown>|null>}
 */
async function getPreset(user, presetId, token) {
  const item = await fetchRawPresetItem(presetId, token);
  return item ? apiToPreset(item, user) : null;
}

/**
 * Lists the caller's own presets, sorted the SAME way Mongo's
 * `getPresets` sorts them (ascending `order`, defaulting missing `order`
 * to `10000`; ties broken by `updatedAt` descending). Mirrors Mongo's
 * `getPresets(user, filter)` signature with `token` appended.
 *
 * @param {string} user
 * @param {Record<string, unknown>} [_filter] - accepted for signature
 *   parity; WU-1-style list endpoints have no arbitrary Mongo-filter
 *   query surface (same documented v1 simplification as
 *   `AuditTraceConversations::getConvosByCursor`'s ignored options) — the
 *   only live caller (`routes/presets.js`) never passes one.
 * @param {string|null|undefined} token
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function getPresets(user, _filter, token) {
  const items = await collectAllPresets(token);
  const presets = items.map((item) => apiToPreset(item, user));
  presets.sort((a, b) => {
    const orderA = a.order !== undefined ? a.order : DEFAULT_ORDER;
    const orderB = b.order !== undefined ? b.order : DEFAULT_ORDER;
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime();
  });
  return presets;
}

/**
 * Create-or-update the caller's own preset. Mirrors Mongo's
 * `savePreset(user, {presetId, newPresetId, defaultPreset, ...preset})`
 * signature with `token` appended.
 *
 * Fetches the EXISTING row first (tolerating "doesn't exist yet") and
 * merges the caller's fields onto its `data` bag before building the
 * upsert body — see the module docstring's "Data-clobber guard".
 * `defaultPreset === true` sets `defaultPreset`/`order: 0` on THIS
 * preset (Mongo's own effect on the target row, minus the cross-row
 * unset — see the module docstring's disclosed v1 simplification);
 * `defaultPreset === false` explicitly clears both.
 *
 * @param {string} user
 * @param {{presetId?: string, newPresetId?: string, defaultPreset?: boolean, [key: string]: unknown}} update
 * @param {string|null|undefined} token
 * @returns {Promise<Record<string, unknown>>}
 */
async function savePreset(user, update, token) {
  const { presetId, newPresetId, defaultPreset, ...rest } = update || {};
  if (typeof presetId !== 'string' || presetId.length === 0) {
    throw new SovereignMemoryError(
      'savePreset requires presetId to route to the sovereign store',
      400,
    );
  }
  const existingRaw = await fetchRawPresetItem(presetId, token);
  const existingData = existingRaw && isPlainObject(existingRaw.data) ? existingRaw.data : {};
  const mergedData = { ...existingData, ...presetDataFields(rest) };
  if (defaultPreset === true) {
    mergedData.defaultPreset = true;
    mergedData.order = 0;
  } else if (defaultPreset === false) {
    delete mergedData.defaultPreset;
    delete mergedData.order;
  }
  const effectivePresetId =
    typeof newPresetId === 'string' && newPresetId.length > 0 ? newPresetId : presetId;
  const title = rest.title !== undefined ? rest.title : existingRaw && existingRaw.title;
  const body = presetUpsertBody(effectivePresetId, title, mergedData);
  const item = await callConsolePresetsProxy({ method: 'POST', path: '', token, body });
  return apiToPreset(item, user);
}

/**
 * Deletes preset(s). Mirrors Mongo's `deletePresets(user, filter)`
 * signature with `token` appended.
 *
 * `filter.presetId` present deletes exactly that one preset (the
 * `routes/presets.js` `POST /delete` shape). Otherwise (an empty/absent
 * filter — `UserController.js`'s "delete everything for this user" call)
 * pages through every preset the caller owns (`collectAllPresets`) and
 * deletes each. A 404 per-id (already deleted) is tolerated, matching
 * Mongo's own idempotent `deleteMany` semantics; any other non-2xx is
 * fail-closed (propagates). Returns `{acknowledged: true, deletedCount}`,
 * matching mongoose's own `DeleteResult` shape (the ONE difference from
 * `AuditTraceConversations::deleteConvos`'s simplified return, chosen
 * here because `routes/presets.js`'s `POST /delete` relays this value
 * straight to the HTTP response body).
 *
 * @param {string} user
 * @param {{presetId?: string}} [filter]
 * @param {string|null|undefined} token
 * @returns {Promise<{acknowledged: true, deletedCount: number}>}
 */
async function deletePresets(user, filter = {}, token) {
  const explicitId =
    typeof filter.presetId === 'string' && filter.presetId.length > 0 ? filter.presetId : null;
  const ids = explicitId
    ? [explicitId]
    : (await collectAllPresets(token)).map((item) => item.preset_id);
  let deletedCount = 0;
  for (const id of ids) {
    try {
      await callConsolePresetsProxy({ method: 'DELETE', path: id, token });
      deletedCount += 1;
    } catch (error) {
      if (isNotFound(error)) {
        continue;
      }
      throw error;
    }
  }
  return { acknowledged: true, deletedCount };
}

/**
 * One binder per shimmed preset method name — SAME discipline as
 * `AuditTraceConversations::SOVEREIGN_METHOD_BINDERS` (a fixed positional
 * arity per name, never a generic arg-spread, so `token` always lands in
 * the right slot regardless of how many optional arguments a call site
 * passes). Merged into the chokepoint's binder map by
 * `AuditTraceConversations/index.js`.
 */
const SOVEREIGN_METHOD_BINDERS = {
  getPreset: (token) => (user, presetId) => getPreset(user, presetId, token),
  getPresets: (token) => (user, filter) => getPresets(user, filter, token),
  savePreset: (token) => (user, update) => savePreset(user, update, token),
  deletePresets: (token) => (user, filter) => deletePresets(user, filter, token),
};

module.exports = {
  getPreset,
  getPresets,
  savePreset,
  deletePresets,
  SOVEREIGN_METHOD_BINDERS,
  // Exported for direct unit testing, not part of the MethodsShaped surface.
  _internal: { collectAllPresets, fetchRawPresetItem },
};
