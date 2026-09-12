/**
 * The sovereign-chat-projects adapter (MongoDB-elimination EPIC,
 * WU-chatprojects — the THIRD reuse of the WU-2b model-layer-chokepoint
 * pattern, following WU-presets and WU-prompts, 2026-09-11/12) — the
 * `~/models` chat-project methods
 * (`packages/data-schemas/src/methods/chatProject.ts`) LibreChat calls
 * for persistence, backed by HTTP calls to the BFF `/console/chat-projects/*`
 * proxy instead of Mongo, gated behind `AUDITTRACE_MEMORY_BACKEND=sovereign`
 * (`../AuditTraceMemory/config`).
 *
 * **Reuses the chokepoint, does not re-invent it.** This module exports
 * ONLY the five chat-project adapter functions + their
 * `SOVEREIGN_METHOD_BINDERS` map (below) — the actual "is this call
 * sovereign, is there a live token" DECISION still happens in exactly
 * ONE place, `AuditTraceConversations/index.js::wrapModelMethods`, which
 * merges this module's binders into its own before wrapping the
 * `createMethods(...)` output (see that module's docstring for the full
 * "why a single export-point chokepoint" rationale). There is
 * deliberately NO second `AsyncLocalStorage`, NO second "backend
 * selected?" branch, and NO second call site in `api/models/index.js` —
 * `wrapModelMethods()` is still called EXACTLY ONCE.
 *
 * ============================================================
 * GROUND-THE-SURFACE ENUMERATION (build-record disclosure — Lesson 1+2:
 * this list must be exhaustive; a partial disclosure is itself a REJECT).
 * ============================================================
 *
 * `packages/data-schemas/src/methods/chatProject.ts::ChatProjectMethods`
 * (returned by `createChatProjectMethods`, spread into `~/models` by
 * `packages/data-schemas/src/methods/index.ts`) exports EXACTLY 7
 * functions. Every one is accounted for below as WIRED or a named,
 * disclosed category. **Set-equality, arithmetic-correct total: 5 wired +
 * 2 disclosed-unwired = 7, matching the interface's own 7-member list
 * (`createChatProject`, `getChatProject`, `listChatProjects`,
 * `updateChatProject`, `deleteChatProject`, `assignConversationToProject`,
 * `refreshChatProjectStats`) exactly.**
 *
 * **WIRED (chokepointed, `SOVEREIGN_METHOD_BINDERS` below) — 5 methods,
 * all mapping cleanly onto the `ConsoleChatProjectItem` CRUD model
 * (`services/console_chat_projects.py`):**
 *   - `createChatProject` — `api/server/routes/projects.js`'s `POST /`
 *     handler (`createProjectHandlers().createProject`,
 *     `packages/api/src/projects/handlers.ts`).
 *   - `getChatProject` — `routes/projects.js`'s `GET /:projectId` handler
 *     AND `api/server/services/Schedules/index.js`'s `getService()`
 *     lazy-built `getChatProject: (userId, projectId) =>
 *     methods.getChatProject(userId, projectId)` dependency (a
 *     schedule-fire-time project-ownership precheck) — see "Module-load-time
 *     capture audit" below for why the latter is safe, not a trap.
 *   - `listChatProjects` — `routes/projects.js`'s `GET /` handler.
 *   - `updateChatProject` — `routes/projects.js`'s `PATCH /:projectId`
 *     handler.
 *   - `deleteChatProject` — `routes/projects.js`'s `DELETE /:projectId`
 *     handler.
 *
 * **DISCLOSED CATEGORY 1 — `assignConversationToProject`, deliberately
 * NOT wired: a conversation-domain write, out of this WU's ratified
 * scope.** Live caller: `routes/projects.js`'s
 * `PUT /conversations/:conversationId` handler. Mongo's own
 * implementation reads/writes the `Conversation` collection (sets or
 * clears `chatProjectId` via `Conversation.findOneAndUpdate`) and then
 * calls `refreshChatProjectStatsForUser` — it is a conversation-persistence
 * operation that happens to validate against a chat-project, not a
 * chat-project-persistence operation. The ratified spec is explicit:
 * "Do NOT re-wire conversation<->project linkage (the conversations shim
 * owns conversation persistence; the conversations store already
 * reserved `chat_project_id`). Map chatProject CRUD only." Binding this
 * method here would mean either (a) writing conversation state from
 * OUTSIDE the conversations shim's chokepoint domain — the exact
 * boundary violation the spec forbids — or (b) faking a
 * conversation-shaped return value this module has no authority to
 * produce correctly. Left unwired, unconditionally Mongo, regardless of
 * the flag; a FUTURE conversations-domain WU is the correct owner if this
 * is ever sovereign-wired.
 *
 * **DISCLOSED CATEGORY 2 — `refreshChatProjectStats`, deliberately NOT
 * wired: an orphaned export AND a genuine store-capability gap.** Grepped
 * exhaustively (`\.refreshChatProjectStats\(` across `api/`, `packages/`,
 * `client/`) — this exported wrapper (distinct from the internal
 * `refreshChatProjectStatsForUser` helper `conversation.ts` calls
 * directly, see below) has NO live `~/models`-level caller anywhere in
 * the fork today. It would ALSO be a genuine capability gap if it did:
 * Mongo's version recomputes `conversationCount`/`lastConversationAt`/
 * `lastConversationId` by counting/joining the caller's OWN
 * `Conversation` documents — a cross-domain computation the sovereign
 * `console_chat_projects` store cannot perform (it has no relation to
 * conversations at all, by the ratified spec's own design). Unlike
 * `AuditTracePresets::getPreset` (wired anyway for parity, because it is
 * a TRIVIAL, faithful CRUD read with zero capability gap), wiring this
 * orphaned export would require either fabricating a stats value this
 * module cannot compute correctly, or silently returning the row
 * UNCHANGED under a method name whose entire contract is "recompute the
 * stats" — both look like correct wiring while being wrong, the same
 * reasoning `AuditTracePrompts/index.js`'s "DISCLOSED CATEGORY 1" gives
 * for leaving prompt ACL/sharing methods unwired. Left unwired,
 * unconditionally Mongo, regardless of the flag.
 *
 * **DISCLOSED FINDING — two standalone helper functions, NOT part of
 * `ChatProjectMethods`, are out of this module's surface entirely.**
 * `chatProject.ts` also exports `refreshChatProjectStatsForUser` and
 * `updateChatProjectLastConversationForUser` at module top level — these
 * are NOT spread into `createChatProjectMethods()`'s return value (see
 * `packages/data-schemas/src/methods/index.ts`: only
 * `...createChatProjectMethods(mongoose)` is spread), so they are never
 * `~/models` exports and this chokepoint cannot see them at all. They are
 * called directly, by raw import, from WITHIN `conversation.ts`'s OWN
 * Mongo methods (`saveConvo`, `updateConvo`-shaped paths, bulk-save,
 * bulk-archive) whenever a conversation write changes its
 * `chatProjectId` — i.e. they are conversation-domain implementation
 * detail, squarely `AuditTraceConversations`'s territory (Category 1
 * above), not this module's. `conversation.ts` also does two DIRECT
 * `mongoose.models.ChatProject` reads of its own (an ownership-validation
 * `.exists()` check in its `saveConvo`-shaped update path, and a bulk
 * ownership pre-check in `bulkSaveConvos`) — same boundary, same
 * reasoning, not touched by this WU.
 *
 * ============================================================
 * MODULE-LOAD-TIME CAPTURE AUDIT (Lesson 3).
 * ============================================================
 * `api/server/services/Schedules/index.js`'s `getService()` does
 * `const methods = require('~/models');` — but this happens LAZILY,
 * inside `getService()`, which is itself memoized ("Build the schedule
 * service on first use") and only ever runs after `api/models/index.js`
 * has already executed and wrapped its exports — so `methods` is already
 * the chokepoint's wrapped object by the time it is captured. The
 * `getChatProject: (userId, projectId) => methods.getChatProject(userId,
 * projectId)` dependency built from it is a closure that re-reads
 * `methods.getChatProject` on EVERY invocation (a property lookup on the
 * SAME cached module object `wrapModelMethods` mutated once), not a
 * value captured once — the SAME safe shape `AuditTracePrompts/index.js`'s
 * docstring documents for `canAccessPromptGroupResource.js`'s top-level
 * `const { getPromptGroup } = require('~/models')`. Grepped
 * `require\(.~/models.\)` and chatProject-shaped destructures across
 * `api/server/middleware/` and `api/server/services/` and found no OTHER
 * capture site for any chat-project method.
 *
 * ============================================================
 * WATCH-LIST (a prior reviewer finding — checked explicitly for
 * chat-projects).
 * ============================================================
 * `packages/api/src/{apiKeys,acl,mcp}` each call `createMethods(mongoose)`
 * directly (`apiKeys/service.ts`, `acl/accessControlService.ts`,
 * `mcp/registry/db/ServerConfigsDB.ts`) — a DIRECT bypass of the
 * `~/models` chokepoint. Grepped all three files (and their spec/test
 * doubles) for any chat-project reference (`ChatProject`, `chatProject`,
 * or any of the 7 method names) and found NONE — these three bypasses
 * exist for API keys, ACL entries, and MCP server configs respectively,
 * never chat-projects. **N/A for chat-projects, confirmed** (the same
 * watch-list the WU-presets and WU-prompts build records checked for
 * their own domains, re-verified here for a third).
 *
 * There is also no OTHER injected-`methods`-param caller for any
 * chat-project method beyond the ONE Schedules dependency named above —
 * `packages/api/src/schedules/service.ts`'s `deps.methods` (the raw
 * `~/models` object threaded as `ScheduleMethods & {...}`) is grepped for
 * any of the 7 chat-project method names and the only hit is the
 * dedicated `deps.getChatProject` top-level dependency (bound in
 * `Schedules/index.js`, already covered above) — `deps.methods` itself
 * never calls a chat-project method.
 *
 * **Unlike presets/prompts, no bulk "delete all for this user" export
 * exists for chat-projects at all** — `ChatProjectMethods` has no
 * `deleteUserChatProjects`-shaped method, and
 * `api/server/controllers/UserController.js`'s account-deletion flow
 * never touches `ChatProject` rows (grepped; confirmed). This is a
 * PRE-EXISTING gap in the fork's Mongo behavior (orphaned `ChatProject`
 * documents survive account deletion today), unrelated to and not
 * introduced by this WU — there is therefore no "background/no-token"
 * chat-project-write category (Lesson 4) beyond the one general boundary
 * the chokepoint itself already documents.
 *
 * ============================================================
 * DISCIPLINE (fail-closed, the id-shape requirement, the "no metadata
 * usage" simplification — all documented at their point of use below).
 * ============================================================
 * **Fail-closed, always.** A non-2xx from `callConsoleChatProjectsProxy`
 * (`SovereignMemoryError`) propagates to the caller unchanged. The one
 * place a `SovereignMemoryError` is deliberately interpreted rather than
 * re-thrown is a 404 read/delete (an absent/foreign chat-project), which
 * maps to `null`/a Mongo-shaped "not found" result — the SAME "not found"
 * semantics Mongo's own `getChatProject`/`updateChatProject`/
 * `deleteChatProject` already have for a no-match query, not a fail-open
 * shortcut (the create/update write path never falls back to Mongo on
 * error).
 *
 * **The id-shape requirement (the SAME "DISCLOSED FINDING" WU-prompts'
 * docstring gives for its own `mintId()`).**
 * `packages/api/src/projects/handlers.ts`'s `getProject`/`updateProject`/
 * `deleteProject` handlers call `isValidObjectIdString(projectId)` and
 * respond 404 BEFORE ever reaching `deps.getChatProject`/
 * `deps.updateChatProject`/`deps.deleteChatProject` when it fails — this
 * fork-side gate is untouched, non-chokepoint code, independent of
 * `AUDITTRACE_MEMORY_BACKEND`. `createChatProject` therefore mints a
 * Mongo-`ObjectId`-shaped hex string (`mintId()`, via the `mongodb`
 * package already used by `AuditTracePrompts` for the identical reason),
 * not an arbitrary string, so a caller's later `GET`/`PATCH`/`DELETE`
 * `/:projectId` on the id this adapter just minted passes that gate.
 *
 * **No metadata usage — a genuine simplification versus presets/prompts.**
 * `AuditTracePresets`/`AuditTracePrompts` both round-trip LibreChat-only
 * fields (a whole config bag; `numberOfGenerations`/`author`/`authorName`)
 * through the sovereign store's generic `metadata` bag, guarded by a
 * fetch-then-merge discipline so a partial update never wipes it. This
 * module has NO such fields to round-trip — the three LibreChat-only
 * chat-project fields (`conversationCount`/`lastConversationAt`/
 * `lastConversationId`) are cross-domain computed values this WU
 * explicitly declines to fake (see `mapping.js`'s docstring) rather than
 * caller-supplied data to preserve, so `metadata` is never read from or
 * written to by this module at all — there is no data-clobber guard to
 * build because there is no data to clobber.
 */

const { ObjectId } = require('mongodb');
const {
  MAX_CHAT_PROJECT_NAME_LENGTH,
  MAX_CHAT_PROJECT_DESCRIPTION_LENGTH,
} = require('librechat-data-provider');
const { callConsoleChatProjectsProxy } = require('./client');
const { chatProjectUpsertBody, apiToProject } = require('./mapping');
const { SovereignMemoryError } = require('../AuditTraceMemory/errors');

/** @param {unknown} error @returns {boolean} */
function isNotFound(error) {
  return error instanceof SovereignMemoryError && error.status === 404;
}

/** Mints an id in Mongo-`ObjectId` hex-string format — see this module's
 *  docstring's "The id-shape requirement" for why the SHAPE (not just
 *  uniqueness) matters here, even though the sovereign store itself
 *  treats `chat_project_id` as an opaque string.
 *  @returns {string} */
function mintId() {
  return new ObjectId().toString();
}

/** @param {unknown} name @returns {string} */
function sanitizeName(name) {
  return typeof name === 'string' ? name.trim().slice(0, MAX_CHAT_PROJECT_NAME_LENGTH) : '';
}

/** @param {unknown} description @returns {string} */
function sanitizeDescription(description) {
  return typeof description === 'string'
    ? description.trim().slice(0, MAX_CHAT_PROJECT_DESCRIPTION_LENGTH)
    : '';
}

/**
 * Fetches the raw (unmapped) `ConsoleChatProjectItem` for one
 * chat-project, or `null` if it doesn't exist/isn't owned. Internal —
 * used by `updateChatProject` (to preserve the current `name`/
 * `description` the caller's partial update omits, since the sovereign
 * API is upsert-only, no PATCH) and by `getChatProject`.
 *
 * @param {string} chatProjectId
 * @param {string|null|undefined} token
 * @returns {Promise<Record<string, unknown>|null>}
 */
async function fetchRawProject(chatProjectId, token) {
  try {
    return await callConsoleChatProjectsProxy({ method: 'GET', path: chatProjectId, token });
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Creates a new chat-project. Mirrors Mongo's
 * `createChatProject(user, {name, description})` signature with `token`
 * appended. Sanitizes `name`/`description` the SAME way Mongo's own
 * `sanitizeProjectInput` does (trim + slice to
 * `MAX_CHAT_PROJECT_NAME_LENGTH`/`MAX_CHAT_PROJECT_DESCRIPTION_LENGTH`)
 * before minting a fresh Mongo-`ObjectId`-shaped id (see this module's
 * docstring's "The id-shape requirement").
 *
 * @param {string} user
 * @param {{name: string, description?: string|null}} input
 * @param {string|null|undefined} token
 * @returns {Promise<Record<string, unknown>>}
 */
async function createChatProject(user, input, token) {
  const name = sanitizeName(input && input.name);
  if (!name) {
    throw new SovereignMemoryError(
      'createChatProject requires a non-empty name to route to the sovereign store',
      400,
    );
  }
  const description = sanitizeDescription(input && input.description);
  const chatProjectId = mintId();
  const body = chatProjectUpsertBody(chatProjectId, { name, description });
  const item = await callConsoleChatProjectsProxy({ method: 'POST', path: '', token, body });
  return apiToProject(item, user);
}

/**
 * Fetches the caller's own chat-project. Mirrors Mongo's
 * `getChatProject(user, projectId)` signature with `token` appended.
 * Returns `null` on a missing/invalid id or a 404 — the SAME "not found
 * or not owned" contract Mongo's `getChatProject` has for a no-match
 * query.
 *
 * @param {string} user
 * @param {string} projectId
 * @param {string|null|undefined} token
 * @returns {Promise<Record<string, unknown>|null>}
 */
async function getChatProject(user, projectId, token) {
  if (typeof projectId !== 'string' || projectId.length === 0) {
    return null;
  }
  const raw = await fetchRawProject(projectId, token);
  return raw ? apiToProject(raw, user) : null;
}

/**
 * Lists the caller's own chat-projects, newest-first by the sovereign
 * store's own `updated_at_ms` ordering. Mirrors Mongo's
 * `listChatProjects(user, options)` signature with `token` appended.
 *
 * **Disclosed v1 simplification: `options.sortBy`/`options.sortDirection`/
 * `options.search` are accepted but IGNORED.** The sovereign API is a
 * single cursor-paginated list with no arbitrary sort/search surface
 * (the SAME documented v1 simplification as
 * `AuditTraceConversations::getConvosByCursor`'s ignored options and
 * `AuditTracePresets::getPresets`'s ignored `_filter`) — every caller
 * always gets the store's own `updated_at_ms desc` order, never
 * `name`-sorted, never ascending, never filtered by `search`.
 *
 * @param {string} user
 * @param {{cursor?: string|null, limit?: number, sortBy?: string,
 *   sortDirection?: string, search?: string}} [options]
 * @param {string|null|undefined} token
 * @returns {Promise<{projects: Record<string, unknown>[], nextCursor: string|null}>}
 */
async function listChatProjects(user, options, token) {
  const opts = options || {};
  const query = {};
  if (typeof opts.limit === 'number' && Number.isFinite(opts.limit)) {
    query.limit = String(Math.min(Math.max(Math.floor(opts.limit), 1), 100));
  }
  if (typeof opts.cursor === 'string' && opts.cursor.length > 0) {
    query.cursor = opts.cursor;
  }
  const resp = await callConsoleChatProjectsProxy({ method: 'GET', path: '', token, query });
  const items = Array.isArray(resp && resp.items) ? resp.items : [];
  return {
    projects: items.map((item) => apiToProject(item, user)),
    nextCursor: (resp && resp.next_cursor) || null,
  };
}

/**
 * Updates the caller's own chat-project's `name`/`description`. Mirrors
 * Mongo's `updateChatProject(user, projectId, input)` signature with
 * `token` appended.
 *
 * The sovereign API is upsert-only (no PATCH) — fetches the EXISTING row
 * first so a field `input` omits keeps its existing value (mirrors
 * Mongo's own partial-update semantics; there is no `metadata` bag to
 * merge here, see this module's docstring's "No metadata usage").
 * Returns `null` when the chat-project doesn't exist/isn't owned/has an
 * invalid id — the SAME "not found" contract Mongo's own
 * `findOneAndUpdate` -> `null` path has.
 *
 * @param {string} user
 * @param {string} projectId
 * @param {{name?: string, description?: string|null}} input
 * @param {string|null|undefined} token
 * @returns {Promise<Record<string, unknown>|null>}
 */
async function updateChatProject(user, projectId, input, token) {
  if (typeof projectId !== 'string' || projectId.length === 0) {
    return null;
  }
  const existing = await fetchRawProject(projectId, token);
  if (existing == null) {
    return null;
  }
  const upd = input || {};
  let name = existing.name;
  if (upd.name !== undefined) {
    name = sanitizeName(upd.name);
    if (!name) {
      throw new SovereignMemoryError('updateChatProject requires a non-empty name', 400);
    }
  }
  let description = existing.description;
  if (upd.description !== undefined) {
    description = sanitizeDescription(upd.description);
  }
  const body = chatProjectUpsertBody(projectId, { name, description });
  const updated = await callConsoleChatProjectsProxy({ method: 'POST', path: '', token, body });
  return apiToProject(updated, user);
}

/**
 * Deletes the caller's own chat-project. Mirrors Mongo's
 * `deleteChatProject(user, projectId)` signature with `token` appended,
 * returning the SAME `{deletedCount, modifiedCount}` shape.
 *
 * **`modifiedCount` is ALWAYS `0` under the sovereign backend — a
 * disclosed, deliberate boundary, not a bug.** Mongo's own
 * `deleteChatProject` additionally unsets `chatProjectId` on every
 * conversation that referenced this project
 * (`Conversation.updateMany(...)`, reflected in Mongo's `modifiedCount`)
 * — a conversation-domain write squarely owned by
 * `AuditTraceConversations`, not this module (see this module's
 * docstring's "DISCLOSED CATEGORY 1"). `deletedCount` is `1` on a
 * successful delete, `0` when the id was invalid/not found/not
 * owned/already deleted (idempotent, matches Mongo's own
 * zero-`deletedCount` "no match" shape) — `packages/api/src/projects/
 * handlers.ts`'s `deleteProject` branches on `!result.deletedCount` to
 * decide 404 vs 200, so this contract is load-bearing, not incidental.
 *
 * @param {string} user
 * @param {string} projectId
 * @param {string|null|undefined} token
 * @returns {Promise<{deletedCount: number, modifiedCount: number}>}
 */
async function deleteChatProject(user, projectId, token) {
  if (typeof projectId !== 'string' || projectId.length === 0) {
    return { deletedCount: 0, modifiedCount: 0 };
  }
  try {
    await callConsoleChatProjectsProxy({ method: 'DELETE', path: projectId, token });
  } catch (error) {
    if (isNotFound(error)) {
      return { deletedCount: 0, modifiedCount: 0 };
    }
    throw error;
  }
  return { deletedCount: 1, modifiedCount: 0 };
}

/**
 * One binder per shimmed chat-project method name — SAME discipline as
 * `AuditTraceConversations::SOVEREIGN_METHOD_BINDERS`/
 * `AuditTracePresets::SOVEREIGN_METHOD_BINDERS`/
 * `AuditTracePrompts::SOVEREIGN_METHOD_BINDERS` (a fixed positional arity
 * per name). Merged into the chokepoint's binder map by
 * `AuditTraceConversations/index.js`. Named here: only the 5 WIRED
 * methods from this module's ground-the-surface enumeration —
 * `assignConversationToProject` and `refreshChatProjectStats` have NO
 * entry here (so `wrapModelMethods` leaves them untouched, always Mongo,
 * regardless of the flag).
 */
const SOVEREIGN_METHOD_BINDERS = {
  createChatProject: (token) => (user, input) => createChatProject(user, input, token),
  getChatProject: (token) => (user, projectId) => getChatProject(user, projectId, token),
  listChatProjects: (token) => (user, options) => listChatProjects(user, options, token),
  updateChatProject: (token) => (user, projectId, input) =>
    updateChatProject(user, projectId, input, token),
  deleteChatProject: (token) => (user, projectId) => deleteChatProject(user, projectId, token),
};

module.exports = {
  createChatProject,
  getChatProject,
  listChatProjects,
  updateChatProject,
  deleteChatProject,
  SOVEREIGN_METHOD_BINDERS,
  // Exported for direct unit testing, not part of the MethodsShaped surface.
  _internal: { mintId, fetchRawProject },
};
