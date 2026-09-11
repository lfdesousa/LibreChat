/**
 * The sovereign-prompts adapter (MongoDB-elimination EPIC, WU-prompts —
 * the SECOND reuse of the WU-2b model-layer-chokepoint pattern, following
 * WU-presets, 2026-09-11) — the `~/models` prompt methods
 * (`packages/data-schemas/src/methods/prompt.ts`) LibreChat calls for
 * persistence, backed by HTTP calls to the BFF `/console/prompts/*` proxy
 * instead of Mongo, gated behind `AUDITTRACE_MEMORY_BACKEND=sovereign`
 * (`../AuditTraceMemory/config`).
 *
 * **Reuses the chokepoint, does not re-invent it.** This module exports
 * ONLY the adapter functions + their `SOVEREIGN_METHOD_BINDERS` map
 * (below) — the actual "is this call sovereign, is there a live token"
 * DECISION still happens in exactly ONE place,
 * `AuditTraceConversations/index.js::wrapModelMethods`, which merges this
 * module's binders into its own before wrapping the `createMethods(...)`
 * output (see that module's docstring for the full "why a single
 * export-point chokepoint" rationale). There is deliberately NO second
 * `AsyncLocalStorage`, NO second "backend selected?" branch, and NO
 * second call site in `api/models/index.js` — `wrapModelMethods()` is
 * still called EXACTLY ONCE.
 *
 * ============================================================
 * GROUND-THE-SURFACE ENUMERATION (build-record disclosure — Lesson 1+2:
 * this list must be exhaustive; a partial disclosure is itself a REJECT).
 * ============================================================
 *
 * `packages/data-schemas/src/methods/prompt.ts::PromptMethods` exports 20
 * functions. Every one is accounted for below as WIRED or a named,
 * disclosed category.
 *
 * **WIRED (chokepointed, `SOVEREIGN_METHOD_BINDERS` below) — 10 methods,
 * all with a live `~/models`-level caller, all mapping cleanly onto the
 * `ConsolePromptGroup`/`ConsolePromptVersion` group+versions model
 * (`services/console_prompts.py`):**
 *   - `createPromptGroup` — `routes/prompts.js`'s `POST /` handler
 *     (`createNewPromptGroup`).
 *   - `savePrompt` — `routes/prompts.js`'s `POST /groups/:groupId/prompts`
 *     handler (`addPromptToGroup`).
 *   - `getPromptGroup` — `routes/prompts.js`'s `GET /groups/:groupId`
 *     handler AND `middleware/accessResources/canAccessPromptGroupResource.js`'s
 *     `resolvePromptGroupId` (both `const { getPromptGroup } =
 *     require('~/models')` — see "Module-load-time capture audit" below).
 *   - `getPrompt` — `routes/prompts.js`'s `GET /:promptId` handler AND its
 *     `PATCH /:promptId/tags/production` handler AND
 *     `middleware/accessResources/canAccessPromptViaGroup.js`'s
 *     `resolvePromptToGroupId`.
 *   - `getPrompts` — `routes/prompts.js`'s `GET /` handler (both the
 *     `groupId`-filtered branch and the caller's-own-prompts branch).
 *   - `updatePromptGroup` — `routes/prompts.js`'s `PATCH /groups/:groupId`
 *     handler (`patchPromptGroup`).
 *   - `makePromptProduction` — `routes/prompts.js`'s
 *     `PATCH /:promptId/tags/production` handler.
 *   - `deletePromptGroup` — `routes/prompts.js`'s `DELETE /groups/:groupId`
 *     handler (`deletePromptGroupController`).
 *   - `deleteUserPrompts` — `api/server/controllers/UserController.js`'s
 *     account-deletion flow (`db.deleteUserPrompts(user.id)`, the SAME
 *     module-load-time `const db = require('~/models')` shape as
 *     WU-presets' `deletePresets` caller — see "Module-load-time capture
 *     audit" below).
 *   - `incrementPromptGroupUsage` — `routes/prompts.js`'s
 *     `POST /groups/:groupId/use` handler.
 *
 * **DISCLOSED CATEGORY 1 — ACL/sharing methods, deliberately NOT wired,
 * stay on Mongo unconditionally (no `SOVEREIGN_METHOD_BINDERS` entry at
 * all, so `wrapModelMethods` never touches them regardless of the flag):**
 * `getPromptGroupAccessContext`, `getListPromptGroupsByAccess`,
 * `getOwnedPromptGroupIds`, `invalidatePromptGroupAccessContext`. These
 * compute CROSS-USER visibility (ACL principals, publicly-accessible
 * resource ids, permission-cache invalidation via
 * `services/PermissionService.js`) — a genuinely different domain
 * capability than persisting one caller's OWN prompt content. The
 * sovereign `console_prompts` store has NO sharing/ACL concept at all
 * (every group/version query filters by `user_sub` exclusively, per
 * `services/console_prompts.py`'s module docstring) — there is no
 * "publicly accessible" or "principal-based access" notion to translate
 * these into. Forcing them through the sovereign path would mean either
 * fabricating an always-empty sharing result (silently breaking "shared
 * prompts" for every user) or building a whole separate ACL-replication
 * system, both explicitly out of scope for a persistence-chokepoint WU.
 * This is a DIFFERENT kind of disclosed boundary than Lesson 4's
 * "no-live-token" background-writes case — here the gap is a missing
 * domain capability in the sovereign store, not a missing token.
 *
 * **DISCLOSED FINDING — the ACL middleware GATE stands in front of every
 * wired route regardless of backend.** `routes/prompts.js`'s
 * `canAccessPromptGroupResource`/`canAccessPromptViaGroup` middleware
 * (via `middleware/accessResources/canAccessResource.js` ->
 * `services/PermissionService.js::checkPermission`) is ENTIRELY
 * Mongo/ACL-based and is NOT part of this WU's `~/models` chokepoint —
 * it runs BEFORE the wired handler, independent of
 * `AUDITTRACE_MEMORY_BACKEND`. `createNewPromptGroup`'s unconditional
 * `grantPermission({resourceId: result.prompt.groupId, ...})` call (also
 * untouched, non-chokepoint code) is what makes the owner's OWN
 * subsequent requests pass that gate — this is WHY `createPromptGroup`/
 * `savePrompt` below mint Mongo-`ObjectId`-shaped ids (`mintId()`, via
 * the `mongodb` package already used elsewhere in this fork, e.g.
 * `routes/prompts.js`'s own `new ObjectId(groupId)` casts) rather than an
 * arbitrary string: `grantPermission`'s ACL write and every downstream
 * `new ObjectId(...)`/`isValidObjectIdString(...)` cast this fork's
 * (untouched) ACL/route code performs on a prompt group/prompt id would
 * otherwise throw. This keeps the interaction from crashing by
 * construction; it does NOT make prompt sharing "sovereign" — sharing
 * stays exactly what Category 1 above describes. Not exercised live in
 * this WU (Rules 2/3 are deferred to deploy, per the ratified spec).
 *
 * **DISCLOSED CATEGORY 2 — a genuine store-capability gap: single-version
 * delete has no sovereign endpoint.** `deletePrompt` (delete ONE prompt
 * VERSION, keeping the group if other versions remain) has a live caller
 * (`routes/prompts.js`'s `DELETE /:promptId`) but is deliberately NOT
 * wired: `services/console_prompts.py`'s API exposes only
 * `DELETE /console/prompts/{group_id}` (deletes the WHOLE group and ALL
 * its versions) — there is no endpoint to remove a single version while
 * preserving its siblings. Implementing this correctly is a server-side
 * (AuditTrace-AI) follow-up, not a client-side workaround this fork can
 * fake; `deletePrompt` therefore has no `SOVEREIGN_METHOD_BINDERS` entry
 * and stays on Mongo unconditionally, regardless of the flag.
 *
 * **DISCLOSED CATEGORY 3 — orphaned exports (no `~/models`-level caller
 * anywhere in the fork, grepped exhaustively across `api/`, `packages/`,
 * `client/`, `config/`), left unwired:**
 *   - `getPromptGroups`, `getAllPromptGroups`: paginated/global listing
 *     with skip-based pagination and (for `getAllPromptGroups`) NO
 *     author filter at all (a genuinely GLOBAL, cross-user query in
 *     Mongo). Binding either to the per-user-isolated sovereign store
 *     would silently narrow "all users' groups" to "just mine" for any
 *     FUTURE caller that inherits it via the chokepoint — worse than
 *     leaving it unwired, since the WRONG behavior would look like
 *     correct wiring. Left unwired.
 *   - `getRandomPromptGroups`: category-randomization sampling with no
 *     sovereign-API equivalent (no "distinct categories" primitive).
 *   - `getPromptGroupsWithPrompts`: a Mongoose `.populate('prompts')`
 *     virtual-relation query; `get_group`'s existing `versions` array
 *     already covers the live use case (`getPromptGroup` above), and this
 *     export has no caller of its own.
 *   - `updatePromptLabels`: no `~/models`-level caller (only
 *     `client/`/`packages/data-provider` reference it — a route that
 *     would call it does not exist in `routes/prompts.js`); ALSO a
 *     genuine schema gap — `ConsolePromptVersion` has no `labels` column
 *     or metadata-bag convention defined for it in the ratified store
 *     spec, so inventing one here (rather than in the store's own spec)
 *     would be scope creep beyond this WU's ratified boundary.
 *
 * **Module coverage summary: 10 wired + 4 ACL-category + 1 middleware
 * finding (not a method) + 1 store-capability-gap category + 5 orphans =
 * all 20 `PromptMethods` exports accounted for.**
 *
 * ============================================================
 * MODULE-LOAD-TIME CAPTURE AUDIT (Lesson 3).
 * ============================================================
 * `middleware/accessResources/canAccessPromptGroupResource.js` and
 * `canAccessPromptViaGroup.js` both do `const { getPromptGroup } =
 * require('~/models')` / `const { getPrompt } = require('~/models')` at
 * TOP LEVEL (module load). This is SAFE, not a trap: `require('~/models')`
 * returns the SAME module-cache singleton `api/models/index.js` already
 * exported, whose `getPromptGroup`/`getPrompt` properties are ALREADY the
 * chokepoint's call-time-dispatching wrappers (built once by
 * `wrapModelMethods`, which reads `isSovereignBackend()`/
 * `getRequestAccessToken()` freshly INSIDE the wrapper on every
 * invocation, never at wrap/require time) — the SAME reasoning
 * `AuditTracePresets/index.js`'s docstring gives for `UserController.js`'s
 * `const db = require('~/models')`. Grepped for `require\(.~/models.\)`
 * and prompt-shaped destructures across `api/server/middleware/` and
 * found exactly these two, both safe by the same construction.
 *
 * ============================================================
 * WATCH-LIST (a prior reviewer finding — checked explicitly for prompts).
 * ============================================================
 * `packages/api/src/{apiKeys,acl,mcp}` each call `createMethods(mongoose)`
 * directly (`apiKeys/service.ts`, `acl/accessControlService.ts`,
 * `mcp/registry/db/ServerConfigsDB.ts`) — a DIRECT bypass of the
 * `~/models` chokepoint, since these construct their OWN raw-Mongo
 * methods object rather than importing the wrapped one. Grepped all
 * three files for any prompt-method call (`\.(getPrompt|getPrompts|
 * savePrompt|createPromptGroup|updatePromptGroup|deletePromptGroup|
 * deletePrompt|deleteUserPrompts|makePromptProduction|
 * incrementPromptGroupUsage|getPromptGroup\b|getPromptGroups|
 * getAllPromptGroups|getListPromptGroupsByAccess|getRandomPromptGroups|
 * getPromptGroupsWithPrompts|getOwnedPromptGroupIds|
 * getPromptGroupAccessContext|invalidatePromptGroupAccessContext|
 * updatePromptLabels)\(` on their own `_dbMethods`/`methods` bindings and
 * found NONE — these three bypasses exist for API keys, ACL entries, and
 * MCP server configs respectively, never prompts. **N/A for prompts,
 * confirmed** (the same watch-list the WU-presets build record checked
 * for presets, re-verified here for a different domain).
 *
 * There is also no injected-`methods`-param caller for ANY prompt method
 * — `services/Schedules/index.js` (the WU-2b `schedules.js` trap this WU
 * was warned about) only threads `getChatProject`/
 * `isAgentTriggerPrincipalActive`, never a prompt method. Grepped
 * `methods\.(get|save|create|update|delete|increment|invalidate|make)Prompt`
 * across the whole fork; `routes/prompts.js`'s own top-level
 * `require('~/models')` destructure (the normal route shape) is the only
 * hit, not a threaded param.
 *
 * ============================================================
 * DISCIPLINE (fail-closed, the upsert_version quirk, the usage-counter
 * race — all documented at their point of use below).
 * ============================================================
 * **Fail-closed, always.** A non-2xx from `callConsolePromptsProxy`
 * (`SovereignMemoryError`) propagates to the caller unchanged, EXCEPT the
 * two documented "map a 404 to Mongo's own success-shaped not-found
 * message" cases (`updatePromptGroup`, `makePromptProduction` — see their
 * own docstrings) which mirror Mongo's OWN return contract exactly
 * (Mongo's raw methods never throw for "not found", they return
 * `{message: '...'}` at 200) rather than inventing a NEW error shape a
 * caller wasn't already handling. No method here ever falls back to a
 * Mongo call on error.
 *
 * **Sidesteps `upsert_version`'s known group-reassign quirk, does not
 * reproduce it.** `services/console_prompts.py::upsert_version` looks up
 * an existing version by `(user_sub, prompt_id)` ONLY (no `group_id`
 * filter in that lookup) — resubmitting an EXISTING `prompt_id` under a
 * DIFFERENT `group_id` silently updates that row's `text`/`type`/
 * `metadata` in place WITHOUT reattaching it to the new group. `savePrompt`
 * below never triggers this: it mints a BRAND NEW `promptId` on every
 * call (mirroring Mongo's own `Prompt.create` always minting a new `_id`
 * — LibreChat's `savePrompt` is a "add a new prompt to the group" action,
 * never an in-place edit of an existing version), so it can never collide
 * with an existing row under a different group. `createPromptGroup`
 * mints a fresh id for the SAME reason (a brand-new group's first
 * version can never already exist anywhere).
 */

const { ObjectId } = require('mongodb');
const { callConsolePromptsProxy } = require('./client');
const {
  isPlainObject,
  groupUpsertBody,
  versionUpsertBody,
  apiToGroup,
  apiToVersion,
} = require('./mapping');
const { SovereignMemoryError } = require('../AuditTraceMemory/errors');

const COLLECT_ALL_PAGE_SIZE = 100;

/** @param {unknown} error @returns {boolean} */
function isNotFound(error) {
  return error instanceof SovereignMemoryError && error.status === 404;
}

/** Mints an id in Mongo-`ObjectId` hex-string format — see this module's
 *  docstring's "DISCLOSED FINDING" for why the SHAPE (not just
 *  uniqueness) matters here, even though the sovereign store itself
 *  treats `group_id`/`prompt_id` as opaque strings.
 *  @returns {string} */
function mintId() {
  return new ObjectId().toString();
}

/**
 * Fetches the raw (unmapped) `ConsolePromptGroupWithVersionsItem` for one
 * group, or `null` if it doesn't exist/isn't owned. Internal — used by
 * every method below that needs the group's existing fields (for the
 * metadata merge-before-write guard) or its version list.
 *
 * @param {string} groupId
 * @param {string|null|undefined} token
 * @returns {Promise<Record<string, unknown>|null>}
 */
async function fetchRawGroup(groupId, token) {
  try {
    return await callConsolePromptsProxy({ method: 'GET', path: groupId, token });
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Pages through `GET /console/prompts` to collect every (summary,
 * versionless) group row the caller owns — used whenever a method needs
 * "every group I own" (delete-all, the caller's-own-prompts listing, the
 * no-groupId `getPrompt`/`makePromptProduction` lookups).
 *
 * @param {string|null|undefined} token
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function collectAllRawGroups(token) {
  const items = [];
  let cursor;
  for (;;) {
    const query = { limit: String(COLLECT_ALL_PAGE_SIZE) };
    if (cursor) {
      query.cursor = cursor;
    }
    const resp = await callConsolePromptsProxy({ method: 'GET', path: '', token, query });
    const page = Array.isArray(resp && resp.items) ? resp.items : [];
    items.push(...page);
    cursor = resp && resp.next_cursor;
    if (!cursor) {
      break;
    }
  }
  return items;
}

/**
 * Scans every group the caller owns for a version matching `promptId`.
 * Bounded by the caller's own group count — the SAME documented cost as
 * `AuditTraceConversations::getMessage`'s "no direct global lookup"
 * fallback (WU-1's API has no bare, cross-group `prompt_id` lookup
 * either). Used by `getPrompt` (no `groupId` given) and
 * `makePromptProduction` (Mongo's signature only takes a `promptId`).
 *
 * @param {string} promptId
 * @param {string|null|undefined} token
 * @returns {Promise<{groupId: string, version: Record<string, unknown>}|null>}
 */
async function findOwningGroupForVersion(promptId, token) {
  const groups = await collectAllRawGroups(token);
  for (const summary of groups) {
    const raw = await fetchRawGroup(summary.group_id, token);
    const versions = raw && Array.isArray(raw.versions) ? raw.versions : [];
    const found = versions.find((v) => v.prompt_id === promptId);
    if (found) {
      return { groupId: summary.group_id, version: found };
    }
  }
  return null;
}

/**
 * Creates a prompt group AND its first prompt version, then marks that
 * version production — a single logical "create" mirroring Mongo's
 * `createPromptGroup({prompt, group, author, authorName})`, which does
 * the SAME three-step sequence (create group, create prompt, point
 * `productionId` at it) in one Mongo transaction-less call.
 *
 * @param {{prompt: {prompt: string, type?: string}, group: {name: string,
 *   category?: string, oneliner?: string, command?: string},
 *   author?: string, authorName?: string}} saveData
 * @param {string|null|undefined} token
 * @returns {Promise<{prompt: Record<string, unknown>, group: Record<string, unknown>}>}
 */
async function createPromptGroup(saveData, token) {
  const { prompt, group, author, authorName } = saveData || {};
  if (!group || typeof group.name !== 'string' || group.name.length === 0) {
    throw new SovereignMemoryError(
      'createPromptGroup requires group.name to route to the sovereign store',
      400,
    );
  }
  if (!prompt || typeof prompt.prompt !== 'string' || prompt.prompt.length === 0) {
    throw new SovereignMemoryError(
      'createPromptGroup requires prompt.prompt to route to the sovereign store',
      400,
    );
  }
  const groupId = mintId();
  const promptId = mintId();
  const groupBody = groupUpsertBody(groupId, {
    name: group.name,
    category: group.category,
    oneliner: group.oneliner,
    command: group.command,
    metadata: { author, authorName, numberOfGenerations: 0 },
  });
  await callConsolePromptsProxy({ method: 'POST', path: '', token, body: groupBody });
  const versionBody = versionUpsertBody(promptId, {
    text: prompt.prompt,
    type: prompt.type,
    metadata: { author },
  });
  const versionItem = await callConsolePromptsProxy({
    method: 'POST',
    path: `${groupId}/versions`,
    token,
    body: versionBody,
  });
  const groupWithProduction = await callConsolePromptsProxy({
    method: 'PATCH',
    path: `${groupId}/production`,
    token,
    body: { prompt_id: promptId },
  });
  const newPrompt = apiToVersion(versionItem);
  const newGroup = apiToGroup(groupWithProduction);
  return {
    prompt: newPrompt,
    group: { ...newGroup, productionPrompt: { prompt: newPrompt.prompt } },
  };
}

/**
 * Adds a NEW prompt version to an existing group. Mirrors Mongo's
 * `savePrompt({prompt: {groupId, prompt, type}, author})` — Mongo's own
 * implementation ALWAYS calls `Prompt.create(...)`, i.e. this is always a
 * create of a brand-new version, never an in-place edit (see this
 * module's docstring's "Sidesteps `upsert_version`'s known group-reassign
 * quirk").
 *
 * Unlike Mongo's own `savePrompt` (which catches every error and returns
 * `{message: 'Error saving prompt'}` at HTTP 200), a sovereign-backend
 * failure here propagates (`SovereignMemoryError`) — the SAME fail-closed
 * divergence `AuditTracePresets::getPreset`'s docstring already documents
 * for the legacy "error at 200" shape.
 *
 * @param {{prompt: {groupId: string, prompt: string, type?: string},
 *   author?: string}} saveData
 * @param {string|null|undefined} token
 * @returns {Promise<{prompt: Record<string, unknown>}>}
 */
async function savePrompt(saveData, token) {
  const { prompt, author } = saveData || {};
  if (!prompt || typeof prompt.groupId !== 'string' || prompt.groupId.length === 0) {
    throw new SovereignMemoryError(
      'savePrompt requires prompt.groupId to route to the sovereign store',
      400,
    );
  }
  if (typeof prompt.prompt !== 'string' || prompt.prompt.length === 0) {
    throw new SovereignMemoryError(
      'savePrompt requires prompt.prompt to route to the sovereign store',
      400,
    );
  }
  const promptId = mintId();
  const versionBody = versionUpsertBody(promptId, {
    text: prompt.prompt,
    type: prompt.type,
    metadata: { author },
  });
  const versionItem = await callConsolePromptsProxy({
    method: 'POST',
    path: `${prompt.groupId}/versions`,
    token,
    body: versionBody,
  });
  return { prompt: apiToVersion(versionItem) };
}

/**
 * Fetches the caller's own prompt group, with `productionPrompt`
 * populated from its version list (mirrors Mongo's own `$lookup`
 * aggregation). Mirrors Mongo's `getPromptGroup({_id})` signature.
 * Returns `null` on 404/malformed filter — the SAME "no match" contract
 * Mongo's own try/catch-to-`null` has.
 *
 * @param {{_id?: string}} filter
 * @param {string|null|undefined} token
 * @returns {Promise<Record<string, unknown>|null>}
 */
async function getPromptGroup(filter, token) {
  const groupId = filter && filter._id;
  if (typeof groupId !== 'string' || groupId.length === 0) {
    return null;
  }
  const raw = await fetchRawGroup(groupId, token);
  if (raw == null) {
    return null;
  }
  const versions = Array.isArray(raw.versions) ? raw.versions : [];
  const productionVersion = versions.find((v) => v.prompt_id === raw.production_prompt_id);
  const result = apiToGroup(raw);
  result.productionPrompt = productionVersion ? { prompt: productionVersion.text } : null;
  return result;
}

/**
 * Fetches a single prompt version by id. Mirrors Mongo's
 * `getPrompt({_id: promptId})` signature (the only shape any caller
 * uses — see this module's docstring's ground-the-surface list). When
 * `filter.groupId` IS supplied (an optional addition over Mongo's own
 * shape, unused by any current caller but accepted defensively), this
 * goes straight to that group; otherwise it scans every group the caller
 * owns (`findOwningGroupForVersion`).
 *
 * @param {{_id?: string, groupId?: string}} filter
 * @param {string|null|undefined} token
 * @returns {Promise<Record<string, unknown>|null>}
 */
async function getPrompt(filter, token) {
  const promptId = filter && filter._id;
  if (typeof promptId !== 'string' || promptId.length === 0) {
    return null;
  }
  const explicitGroupId = filter && filter.groupId;
  if (typeof explicitGroupId === 'string' && explicitGroupId.length > 0) {
    const raw = await fetchRawGroup(explicitGroupId, token);
    const versions = raw && Array.isArray(raw.versions) ? raw.versions : [];
    const found = versions.find((v) => v.prompt_id === promptId);
    return found ? apiToVersion(found) : null;
  }
  const owning = await findOwningGroupForVersion(promptId, token);
  return owning ? apiToVersion(owning.version) : null;
}

/**
 * Lists prompt versions. Mirrors Mongo's `getPrompts(filter)` signature.
 * `filter.groupId` (a string, OR a `mongodb.ObjectId` instance — the
 * route's `GET /` handler passes `new ObjectId(groupId)`, `String(...)`
 * of which yields the same hex string) fetches every version in that ONE
 * group; an absent `groupId` (the "caller's own prompts across every
 * group" branch, `filter.author`) pages through every group the caller
 * owns and flattens their versions, newest-first by `createdAt` (mirrors
 * Mongo's own `.sort({createdAt: -1})`).
 *
 * @param {{groupId?: string|import('mongodb').ObjectId, author?: string}} filter
 * @param {string|null|undefined} token
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function getPrompts(filter, token) {
  const rawGroupId = filter && filter.groupId;
  const groupId = rawGroupId != null ? String(rawGroupId) : undefined;
  if (groupId) {
    const raw = await fetchRawGroup(groupId, token);
    const versions = raw && Array.isArray(raw.versions) ? raw.versions : [];
    return versions.map((v) => apiToVersion(v));
  }
  const groups = await collectAllRawGroups(token);
  const all = [];
  for (const summary of groups) {
    const raw = await fetchRawGroup(summary.group_id, token);
    const versions = raw && Array.isArray(raw.versions) ? raw.versions : [];
    all.push(...versions.map((v) => apiToVersion(v)));
  }
  all.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return all;
}

/**
 * Updates the caller's own prompt group's `name`/`category`/`oneliner`/
 * `command` fields. Mirrors Mongo's `updatePromptGroup(filter, data)`
 * signature. Fetches the EXISTING row first: a field the caller's `data`
 * omits keeps its existing value (mirrors Mongo's own partial-update
 * semantics), and the existing `metadata` bag (author/authorName/
 * numberOfGenerations) is ALWAYS re-sent unchanged — see this module's
 * docstring / `mapping.js`'s "metadata is a full replace" warning.
 *
 * Returns `{message: 'Error updating prompt group'}` when the group
 * doesn't exist/isn't owned — the SAME shape Mongo's own
 * `findOneAndUpdate(..., {upsert: false})` -> `null` -> thrown-then-caught
 * path produces (never a silent create; `upsert: false` has no such
 * concept in the sovereign store, so this checks existence explicitly
 * first instead of relying on the store's own upsert-by-default
 * behavior).
 *
 * @param {{_id?: string}} filter
 * @param {{name?: string, category?: string, oneliner?: string, command?: string}} data
 * @param {string|null|undefined} token
 * @returns {Promise<Record<string, unknown>>}
 */
async function updatePromptGroup(filter, data, token) {
  const groupId = filter && filter._id;
  if (typeof groupId !== 'string' || groupId.length === 0) {
    return { message: 'Error updating prompt group' };
  }
  const existing = await fetchRawGroup(groupId, token);
  if (existing == null) {
    return { message: 'Error updating prompt group' };
  }
  const existingMetadata = isPlainObject(existing.metadata) ? existing.metadata : {};
  const update = data || {};
  const groupBody = groupUpsertBody(groupId, {
    name: update.name !== undefined ? update.name : existing.name,
    category: update.category !== undefined ? update.category : existing.category,
    oneliner: update.oneliner !== undefined ? update.oneliner : existing.oneliner,
    command: update.command !== undefined ? update.command : existing.command,
    metadata: existingMetadata,
  });
  const updated = await callConsolePromptsProxy({
    method: 'POST',
    path: '',
    token,
    body: groupBody,
  });
  return apiToGroup(updated);
}

/**
 * Marks `promptId` as its group's production version. Mirrors Mongo's
 * `makePromptProduction(promptId)` signature — the group is resolved via
 * `findOwningGroupForVersion` since (like Mongo's own `Prompt.findById`
 * lookup) only a bare `promptId` is given.
 *
 * Returns `{message: 'Error making prompt production'}` when the version
 * doesn't exist/isn't owned — mirrors Mongo's own thrown-then-caught
 * `Prompt not found` -> `{message: '...'}` contract exactly (never a
 * silent no-op, but also never a NEW error shape a caller wasn't already
 * handling).
 *
 * @param {string} promptId
 * @param {string|null|undefined} token
 * @returns {Promise<{message: string}>}
 */
async function makePromptProduction(promptId, token) {
  if (typeof promptId !== 'string' || promptId.length === 0) {
    return { message: 'Error making prompt production' };
  }
  const owning = await findOwningGroupForVersion(promptId, token);
  if (owning == null) {
    return { message: 'Error making prompt production' };
  }
  await callConsolePromptsProxy({
    method: 'PATCH',
    path: `${owning.groupId}/production`,
    token,
    body: { prompt_id: promptId },
  });
  return { message: 'Prompt production made successfully' };
}

/**
 * Deletes the caller's own prompt group (and, server-side, ALL of its
 * versions — the sovereign store has no partial-group delete; see this
 * module's docstring's "DISCLOSED CATEGORY 2" for why single-version
 * delete (`deletePrompt`) is a separate, unwired method). Mirrors Mongo's
 * `deletePromptGroup({_id})` signature.
 *
 * On a 404, THROWS a plain `Error('Prompt group not found')` — mirroring
 * Mongo's own `deletePromptGroup`, which has NO try/catch of its own and
 * throws directly on `deletedCount === 0`, propagating to
 * `deletePromptGroupController`'s catch (which responds 500 with the SAME
 * message).
 *
 * @param {{_id?: string}} filter
 * @param {string|null|undefined} token
 * @returns {Promise<{message: string}>}
 */
async function deletePromptGroup(filter, token) {
  const groupId = filter && filter._id;
  if (typeof groupId !== 'string' || groupId.length === 0) {
    throw new SovereignMemoryError(
      'deletePromptGroup requires _id to route to the sovereign store',
      400,
    );
  }
  try {
    await callConsolePromptsProxy({ method: 'DELETE', path: groupId, token });
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error('Prompt group not found');
    }
    throw error;
  }
  return { message: 'Prompt group deleted successfully' };
}

/**
 * Deletes every prompt group the caller owns. Mirrors Mongo's
 * `deleteUserPrompts(userId)` signature with `token` appended — called
 * from `UserController.js`'s account-deletion flow.
 *
 * Simpler than Mongo's own implementation by construction, not a
 * documented gap: Mongo's `deleteUserPrompts` must separately resolve
 * "solely owned" groups vs "co-owned via ACL" groups vs legacy
 * (pre-ACL) groups, because Mongo prompt groups can be SHARED. The
 * sovereign store has no sharing at all (Category 1 above) — every group
 * `list_groups`/`delete_group` return/act on IS, by construction, solely
 * owned by this caller, so there is no co-ownership case to special-case
 * here.
 *
 * @param {string} userId
 * @param {string|null|undefined} token
 * @returns {Promise<void>}
 */
async function deleteUserPrompts(userId, token) {
  const groups = await collectAllRawGroups(token);
  for (const summary of groups) {
    try {
      await callConsolePromptsProxy({ method: 'DELETE', path: summary.group_id, token });
    } catch (error) {
      if (isNotFound(error)) {
        continue;
      }
      throw error;
    }
  }
}

/**
 * Increments the caller's own prompt group's usage counter. Mirrors
 * Mongo's `incrementPromptGroupUsage(groupId)` signature.
 *
 * **Disclosed v1 simplification: not atomic.** Mongo's own
 * `$inc: {numberOfGenerations: 1}` is a single atomic Mongo operation;
 * this adapter's "fetch existing count from `metadata`, increment
 * locally, re-upsert the whole group" has no sovereign-API equivalent
 * for an atomic counter bump, so concurrent calls for the SAME group can
 * lose an increment (a classic read-modify-write race). Accepted here:
 * the counter is a display metric ("used N times"), not an
 * audit-critical value, and the ratified spec's scope is CRUD parity for
 * group/version/production, not counter atomicity.
 *
 * Throws `SovereignMemoryError('Prompt group not found', 404)` on a
 * missing group — its `.message` matches the STRING
 * `routes/prompts.js`'s `POST /groups/:groupId/use` handler branches on
 * (`error.message === 'Prompt group not found'` -> HTTP 404), the SAME
 * contract Mongo's own thrown `Error('Prompt group not found')` gives
 * that handler.
 *
 * @param {string} groupId
 * @param {string|null|undefined} token
 * @returns {Promise<{numberOfGenerations: number}>}
 */
async function incrementPromptGroupUsage(groupId, token) {
  if (typeof groupId !== 'string' || groupId.length === 0) {
    throw new SovereignMemoryError('Invalid groupId', 400);
  }
  const existing = await fetchRawGroup(groupId, token);
  if (existing == null) {
    throw new SovereignMemoryError('Prompt group not found', 404);
  }
  const existingMetadata = isPlainObject(existing.metadata) ? existing.metadata : {};
  const currentCount =
    typeof existingMetadata.numberOfGenerations === 'number'
      ? existingMetadata.numberOfGenerations
      : 0;
  const nextCount = currentCount + 1;
  const groupBody = groupUpsertBody(groupId, {
    name: existing.name,
    category: existing.category,
    oneliner: existing.oneliner,
    command: existing.command,
    metadata: { ...existingMetadata, numberOfGenerations: nextCount },
  });
  await callConsolePromptsProxy({ method: 'POST', path: '', token, body: groupBody });
  return { numberOfGenerations: nextCount };
}

/**
 * One binder per shimmed prompt method name — SAME discipline as
 * `AuditTraceConversations::SOVEREIGN_METHOD_BINDERS`/
 * `AuditTracePresets::SOVEREIGN_METHOD_BINDERS` (a fixed positional arity
 * per name). Merged into the chokepoint's binder map by
 * `AuditTraceConversations/index.js`. Named here: only the 10 WIRED
 * methods from this module's ground-the-surface enumeration — every
 * other `PromptMethods` export is a disclosed category and has NO entry
 * here (so `wrapModelMethods` leaves it untouched, always Mongo,
 * regardless of the flag).
 */
const SOVEREIGN_METHOD_BINDERS = {
  createPromptGroup: (token) => (saveData) => createPromptGroup(saveData, token),
  savePrompt: (token) => (saveData) => savePrompt(saveData, token),
  getPromptGroup: (token) => (filter) => getPromptGroup(filter, token),
  getPrompt: (token) => (filter) => getPrompt(filter, token),
  getPrompts: (token) => (filter) => getPrompts(filter, token),
  updatePromptGroup: (token) => (filter, data) => updatePromptGroup(filter, data, token),
  makePromptProduction: (token) => (promptId) => makePromptProduction(promptId, token),
  deletePromptGroup: (token) => (filter) => deletePromptGroup(filter, token),
  deleteUserPrompts: (token) => (userId) => deleteUserPrompts(userId, token),
  incrementPromptGroupUsage: (token) => (groupId) => incrementPromptGroupUsage(groupId, token),
};

module.exports = {
  createPromptGroup,
  savePrompt,
  getPromptGroup,
  getPrompt,
  getPrompts,
  updatePromptGroup,
  makePromptProduction,
  deletePromptGroup,
  deleteUserPrompts,
  incrementPromptGroupUsage,
  SOVEREIGN_METHOD_BINDERS,
  // Exported for direct unit testing, not part of the MethodsShaped surface.
  _internal: { mintId, fetchRawGroup, collectAllRawGroups, findOwningGroupForVersion },
};
