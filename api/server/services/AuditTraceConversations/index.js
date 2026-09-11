/**
 * The sovereign-conversations adapter (MongoDB-elimination EPIC, WU-2b —
 * the MODEL-LAYER CHOKEPOINT pivot, 2026-09-11, RATIFIED after three
 * route-level-wiring REJECTs) — the `~/models` conversation/message
 * methods (`packages/data-schemas/src/methods/{conversation,message}.ts`)
 * LibreChat calls for persistence, backed by HTTP calls to the BFF
 * `/console/conversations/*` proxy (WU-1) instead of Mongo, gated behind
 * `AUDITTRACE_MEMORY_BACKEND=sovereign` (`../AuditTraceMemory/config`).
 *
 * **The pivot, in one sentence:** route-level wiring
 * (`resolveConversationMethods({req, mongoMethods})`, called at each
 * conversation/message call site) could never be proven COMPLETE, because
 * `~/models` is consumed in more shapes than name-based grep can
 * enumerate — a plain route call, `utils/import/fork.js`'s
 * `const db = require('~/models')`, AND `services/Schedules/index.js`
 * threading the SAME object in as an injected `methods` constructor
 * param. Each round's exhaustive audit found another caller. `
 * wrapModelMethods()` (below) is called EXACTLY ONCE, wrapping the
 * `createMethods(...)` output before `api/models/index.js` exports it —
 * every caller, whatever shape it consumes `~/models` in, gets the SAME
 * wrapped function references, so sovereign-vs-Mongo dispatch is
 * STRUCTURALLY complete (true by construction) rather than
 * enumeration-dependent (true only until the next un-grepped caller).
 *
 * **Token threading is per-call, via `./requestContext`'s
 * `AsyncLocalStorage`, not a parameter.** Model-layer methods receive no
 * `req` — there is no shape a caller could pass one through even if this
 * WU wanted them to. `wrapModelMethods`'s wrapper reads
 * `getRequestAccessToken()` at CALL TIME for every invocation, so the
 * SAME wrapped `saveConvo` reference correctly serves a sovereign-flagged
 * request with a token, a sovereign-flagged background job with NO token
 * (falls to Mongo — the disclosed boundary), and a Mongo-default request,
 * all without the caller doing anything differently.
 *
 * **Fail-closed, always.** A non-2xx from `callConsoleConversationsProxy`
 * (`SovereignMemoryError`) propagates to the caller unchanged — no method
 * here ever falls back to a Mongo call on error. The one place a
 * `SovereignMemoryError` is deliberately interpreted rather than
 * re-thrown is a 404 read (an absent/foreign conversation/message), which
 * maps to `null`/`[]` — the SAME "not found" semantics Mongo's own
 * `getConvo`/`getMessages` already have for a no-match query, not a
 * fail-open shortcut (no write path does this).
 *
 * **Metadata-clobber guard (carried over from the route-level rounds).**
 * WU-1's upsert/edit endpoints REPLACE `metadata` wholesale, never merge
 * it server-side (see `mapping.js`'s module docstring). `saveConvo`/
 * `updateMessage` both fetch the EXISTING row first and merge the
 * caller's delta on top of it before building the request body.
 *
 * **Method coverage.** `SOVEREIGN_METHOD_BINDERS` names every chokepointed
 * method: the 9 the original spec named, plus `getConvoOwnership` (aliased
 * to `getConvo`), `setConvoPinned`, `getMessagesByCursor` (client-side
 * sort/paginate — WU-1's message-tree endpoint has no native pagination),
 * and `bulkSaveConvos`/`bulkSaveMessages` (fan out to individual
 * `saveConvo`/`saveMessage` calls — WU-1 has no bulk endpoint).
 * `forkConversation`/`duplicateConversation`/`forkSharedConversation`
 * (`utils/import/fork.js`) and `ImportBatchBuilder.saveBatch`
 * (`utils/import/importBatchBuilder.js`) are NOT `~/models` exports
 * themselves and need NO wrapping of their own — they call `getConvo`/
 * `getMessages`/`bulkSaveConvos`/`bulkSaveMessages` from `~/models`
 * directly, so they inherit chokepoint routing automatically. See the
 * build record for the residual, explicitly-disclosed boundary (the
 * generation/chat pipeline as its own tracked follow-up; the one honest
 * no-live-token background-writes category this chokepoint cannot and
 * must not fake its way around).
 */

const { callConsoleConversationsProxy } = require('./client');
const {
  isPlainObject,
  convoExtraMetadata,
  convoUpsertBody,
  apiToConvo,
  messageExtraMetadata,
  messageUpsertBody,
  apiToMessage,
} = require('./mapping');
const { SovereignMemoryError } = require('../AuditTraceMemory/errors');
const { isSovereignBackend } = require('../AuditTraceMemory/config');
const { getRequestAccessToken } = require('./requestContext');

const COLLECT_ALL_PAGE_SIZE = 100;
const DEFAULT_MESSAGES_BY_CURSOR_LIMIT = 25;

/** @param {unknown} error @returns {boolean} */
function isNotFound(error) {
  return error instanceof SovereignMemoryError && error.status === 404;
}

/**
 * Normalizes a Mongo-style `{conversationId: ...}` filter fragment into an
 * explicit id list, or `null` when the filter names no explicit id(s) (the
 * "delete/query everything this owner has" case).
 *
 * @param {string|{$in?: string[]}|undefined} value
 * @returns {string[]|null}
 */
function extractIdList(value) {
  if (typeof value === 'string' && value.length > 0) {
    return [value];
  }
  if (value && Array.isArray(value.$in)) {
    return value.$in.filter((v) => typeof v === 'string' && v.length > 0);
  }
  return null;
}

/**
 * Pages through `getConvosByCursor` to collect every conversation id the
 * caller owns — used when a delete targets "everything" (an empty/absent
 * filter), since WU-1's API only exposes a single-id DELETE.
 *
 * @param {string} user
 * @param {string|null|undefined} token
 * @returns {Promise<string[]>}
 */
async function collectAllConversationIds(user, token) {
  const ids = [];
  let cursor;
  for (;;) {
    const page = await getConvosByCursor(user, { cursor, limit: COLLECT_ALL_PAGE_SIZE }, token);
    ids.push(...page.conversations.map((c) => c.conversationId));
    if (!page.nextCursor) {
      break;
    }
    cursor = page.nextCursor;
  }
  return ids;
}

/**
 * Create-or-update the caller's own conversation. Mirrors Mongo's
 * `saveConvo(ctx, data, metadata)` call signature with `token` appended.
 *
 * Fetches the EXISTING row first (tolerating "doesn't exist yet") and
 * merges `ctx.isTemporary` and the metadata-backed fields
 * (`isArchived`/`pinned`/`tags`) onto it before building the upsert body —
 * see the module docstring's "Metadata-clobber guard". A caller that DOES
 * pass one of these fields always wins over the existing value (an
 * explicit change is never overridden by the merge).
 *
 * @param {{userId?: string, isTemporary?: boolean}} ctx
 * @param {{conversationId: string, [key: string]: unknown}} data
 * @param {Record<string, unknown>} [_metadata] - accepted for signature
 *   parity; WU-1's upsert has no `noUpsert`/`preserveUpdatedAt`/
 *   `appendMessageIds` equivalents (out of scope for this WU).
 * @param {string|null|undefined} token
 * @returns {Promise<Record<string, unknown>>}
 */
async function saveConvo(ctx, data, _metadata, token) {
  if (!data || typeof data.conversationId !== 'string' || data.conversationId.length === 0) {
    throw new SovereignMemoryError(
      'saveConvo requires data.conversationId to route to the sovereign store',
      400,
    );
  }
  const existing = await getConvo(undefined, data.conversationId, token);
  const isTemporary =
    ctx && ctx.isTemporary !== undefined
      ? ctx.isTemporary
      : (existing && existing.isTemporary) || false;
  const mergedData = { ...data };
  if (data.isArchived === undefined && existing && existing.isArchived !== undefined) {
    mergedData.isArchived = existing.isArchived;
  }
  if (data.pinned === undefined && existing && existing.pinned !== undefined) {
    mergedData.pinned = existing.pinned;
  }
  if (data.tags === undefined && existing && existing.tags !== undefined) {
    mergedData.tags = existing.tags;
  }
  const body = convoUpsertBody({ isTemporary }, mergedData);
  const item = await callConsoleConversationsProxy({ method: 'POST', path: '', token, body });
  return apiToConvo(item, ctx && ctx.userId);
}

/**
 * Lists the caller's own conversations, cursor-paginated. Mirrors Mongo's
 * `getConvosByCursor(user, options)` signature with `token` appended.
 *
 * `options.isArchived`/`pinned`/`tags`/`search`/`sortBy`/`sortDirection`/
 * `projectId` are accepted but not forwarded — WU-1's list endpoint only
 * supports `cursor`/`limit` (see the module docstring's "v1
 * simplification" note in `mapping.js`).
 *
 * @param {string} user
 * @param {{cursor?: string|null, limit?: number}} [options]
 * @param {string|null|undefined} token
 * @returns {Promise<{conversations: Record<string, unknown>[], nextCursor: string|null}>}
 */
async function getConvosByCursor(user, options = {}, token) {
  const query = {};
  if (options.cursor) {
    query.cursor = options.cursor;
  }
  if (options.limit) {
    query.limit = String(options.limit);
  }
  const resp = await callConsoleConversationsProxy({ method: 'GET', path: '', token, query });
  const items = Array.isArray(resp && resp.items) ? resp.items : [];
  return {
    conversations: items.map((item) => apiToConvo(item, user)),
    nextCursor: (resp && resp.next_cursor) ?? null,
  };
}

/**
 * Fetches the caller's own conversation. Mirrors Mongo's
 * `getConvo(user, conversationId)` signature with `token` appended.
 * Returns `null` on 404 — the SAME "not found or not owned" contract
 * Mongo's `getConvo` has for a no-match query.
 *
 * Also serves as the sovereign implementation of Mongo's
 * `getConvoOwnership(user, conversationId, tenantId?)` (bound under that
 * name too, in `SOVEREIGN_METHOD_BINDERS` below) — that method's
 * `{user, tenantId, subagentThread}` projection is a strict SUBSET of
 * what this returns; callers only ever check truthiness and
 * `.subagentThread` (always `undefined` under sovereign — correctly read
 * as "not a subagent thread", since subagent threads are not migrated).
 *
 * @param {string} user
 * @param {string} conversationId
 * @param {string|null|undefined} token
 * @returns {Promise<Record<string, unknown>|null>}
 */
async function getConvo(user, conversationId, token) {
  try {
    const item = await callConsoleConversationsProxy({
      method: 'GET',
      path: conversationId,
      token,
    });
    return apiToConvo(item, user);
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Toggles the caller's own conversation's pinned flag. Mirrors Mongo's
 * `setConvoPinned(user, conversationId, pinned)` signature with `token`
 * appended. A thin `saveConvo` convenience — `saveConvo`'s own merge
 * guard is what protects `isArchived`/`tags`/`isTemporary` here.
 *
 * @param {string} user
 * @param {string} conversationId
 * @param {boolean} pinned
 * @param {string|null|undefined} token
 * @returns {Promise<Record<string, unknown>|null>}
 */
async function setConvoPinned(user, conversationId, pinned, token) {
  return saveConvo({ userId: user }, { conversationId, pinned: Boolean(pinned) }, undefined, token);
}

/**
 * Deletes the caller's own conversation(s). Mirrors Mongo's
 * `deleteConvos(user, filter, options)` signature with `token` appended.
 *
 * WU-1 only exposes a single-id `DELETE`, so this fans out: an explicit
 * `filter.conversationId` (a string or `{$in: [...]}`) deletes exactly
 * those ids; an empty/absent filter pages through every conversation the
 * caller owns first (`collectAllConversationIds`) and deletes each — the
 * "delete everything" case `routes/convos.js`'s `DELETE /all` uses.
 * `options.beforeDelete(ids)` (Mongo's own generation-drain hook) is
 * invoked, if given, with the resolved id list BEFORE any delete is
 * issued — same ordering Mongo's model uses. There is no subagent-thread
 * lineage walk (Mongo's own recursive "delete descendants" pass): subagent
 * threads are not migrated to sovereign, so there is no lineage to walk.
 * A 404 per-id (already deleted) is tolerated, matching delete-many's own
 * idempotent semantics; any other non-2xx is fail-closed (propagates).
 *
 * @param {string} user
 * @param {{conversationId?: string|{$in?: string[]}}} [filter]
 * @param {{beforeDelete?: (ids: string[]) => Promise<void>}} [options]
 * @param {string|null|undefined} token
 * @returns {Promise<{deletedCount: number, conversationIds: string[]}>}
 */
async function deleteConvos(user, filter = {}, options, token) {
  const explicitIds = extractIdList(filter && filter.conversationId);
  const ids = explicitIds ?? (await collectAllConversationIds(user, token));
  if (ids.length > 0 && options && typeof options.beforeDelete === 'function') {
    await options.beforeDelete(ids);
  }
  let deletedCount = 0;
  const conversationIds = [];
  for (const id of ids) {
    try {
      await callConsoleConversationsProxy({ method: 'DELETE', path: id, token });
      deletedCount += 1;
      conversationIds.push(id);
    } catch (error) {
      if (isNotFound(error)) {
        continue;
      }
      throw error;
    }
  }
  return { deletedCount, conversationIds };
}

/**
 * Create-or-update the caller's own message. Mirrors Mongo's
 * `saveMessage(ctx, params, metadata)` signature with `token` appended.
 *
 * @param {{userId?: string}} ctx
 * @param {{conversationId: string, messageId: string, [key: string]: unknown}} params
 * @param {Record<string, unknown>} [_metadata] - accepted for signature parity.
 * @param {string|null|undefined} token
 * @returns {Promise<Record<string, unknown>>}
 */
async function saveMessage(ctx, params, _metadata, token) {
  if (
    !params ||
    typeof params.conversationId !== 'string' ||
    params.conversationId.length === 0 ||
    typeof params.messageId !== 'string' ||
    params.messageId.length === 0
  ) {
    throw new SovereignMemoryError(
      'saveMessage requires conversationId and messageId to route to the sovereign store',
      400,
    );
  }
  const body = messageUpsertBody(params);
  const item = await callConsoleConversationsProxy({
    method: 'POST',
    path: `${params.conversationId}/messages`,
    token,
    body,
  });
  return apiToMessage(item, params.user ?? (ctx && ctx.userId));
}

/**
 * Fetches the raw (unmapped) `ConsoleMessageItem` for one message, or
 * `null` if the conversation/message doesn't exist/isn't owned. Internal —
 * used by `updateMessage` to merge metadata before a PATCH (see the
 * module docstring's "Metadata-clobber guard"); callers needing the
 * LibreChat-shaped object should use `getMessage`/`getMessages` instead.
 *
 * @param {string} conversationId
 * @param {string} messageId
 * @param {string|null|undefined} token
 * @returns {Promise<Record<string, unknown>|null>}
 */
async function fetchRawMessageItem(conversationId, messageId, token) {
  try {
    const resp = await callConsoleConversationsProxy({
      method: 'GET',
      path: `${conversationId}/messages`,
      token,
    });
    const items = Array.isArray(resp && resp.items) ? resp.items : [];
    return items.find((item) => item.message_id === messageId) ?? null;
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Edits the caller's own message. Mirrors Mongo's
 * `updateMessage(userId, message, metadata)` signature with `token`
 * appended. `message.conversationId` is REQUIRED — WU-1 addresses a
 * message by `{conversation_id}/messages/{message_id}`, unlike Mongo's
 * `_id`-addressable update; a caller that omits it gets a loud 400, never
 * a silent no-op.
 *
 * Fetches the message's EXISTING raw metadata first and merges the
 * caller's `message.metadata`/`content`/`userSubmittedPaths`/`tokenCount`
 * on top of it before PATCHing — see the module docstring's
 * "Metadata-clobber guard". `tokenCount` has no PATCH column (WU-1's edit
 * endpoint only accepts `text`/`metadata`); an edited count is shadowed
 * into `metadata.tokenCount` (`apiToMessage` prefers it over the
 * creation-time `token_count` column).
 *
 * @param {string} userId
 * @param {{conversationId: string, messageId: string, text?: string,
 *   content?: unknown[], userSubmittedPaths?: string[], tokenCount?: number,
 *   metadata?: Record<string, unknown>}} message
 * @param {Record<string, unknown>} [_metadata] - accepted for signature parity.
 * @param {string|null|undefined} token
 * @returns {Promise<Record<string, unknown>>}
 */
async function updateMessage(userId, message, _metadata, token) {
  if (
    !message ||
    typeof message.conversationId !== 'string' ||
    message.conversationId.length === 0 ||
    typeof message.messageId !== 'string' ||
    message.messageId.length === 0
  ) {
    throw new SovereignMemoryError(
      'updateMessage requires conversationId and messageId to route to the sovereign store',
      400,
    );
  }
  const existingRaw = await fetchRawMessageItem(message.conversationId, message.messageId, token);
  const existingMetadata =
    existingRaw && isPlainObject(existingRaw.metadata) ? existingRaw.metadata : {};
  const callerMetadata = isPlainObject(message.metadata) ? message.metadata : {};
  const mergedMetadata = {
    ...existingMetadata,
    ...callerMetadata,
    ...messageExtraMetadata(message),
  };
  const body = {};
  if (message.text !== undefined) {
    body.text = message.text;
  }
  if (Object.keys(mergedMetadata).length > 0) {
    body.metadata = mergedMetadata;
  }
  const item = await callConsoleConversationsProxy({
    method: 'PATCH',
    path: `${message.conversationId}/messages/${message.messageId}`,
    token,
    body,
  });
  return apiToMessage(item, userId);
}

/**
 * Returns the message tree for one conversation, optionally narrowed to
 * one `messageId` (or a `{$in: [...]}` set). Mirrors Mongo's
 * `getMessages(filter, select, options)` signature with `token` appended.
 *
 * `filter.conversationId` is REQUIRED — WU-1's API has no arbitrary
 * Mongo-filter query surface; a caller relying on some OTHER filter shape
 * gets a loud 400, never a silently-empty/wrong result. A 404 (conversation
 * not found/not owned) maps to `[]`, matching Mongo's own no-match
 * semantics for a filter query (not an error condition for a list read).
 *
 * @param {{conversationId?: string, messageId?: string|{$in?: string[]}, user?: string}} filter
 * @param {string} [_select] - accepted for signature parity (field
 *   projection has no sovereign-API equivalent; the full row is always
 *   returned and mapped).
 * @param {Record<string, unknown>} [_options] - accepted for signature parity.
 * @param {string|null|undefined} token
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function getMessages(filter, _select, _options, token) {
  const conversationId = filter && filter.conversationId;
  if (typeof conversationId !== 'string' || conversationId.length === 0) {
    throw new SovereignMemoryError(
      'getMessages requires filter.conversationId to route to the sovereign store ' +
        '(arbitrary Mongo filters have no sovereign equivalent)',
      400,
    );
  }
  let mapped;
  try {
    const resp = await callConsoleConversationsProxy({
      method: 'GET',
      path: `${conversationId}/messages`,
      token,
    });
    const items = Array.isArray(resp && resp.items) ? resp.items : [];
    mapped = items.map((item) => apiToMessage(item, filter.user));
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }
    throw error;
  }
  const messageIdFilter = filter && filter.messageId;
  if (typeof messageIdFilter === 'string' && messageIdFilter.length > 0) {
    return mapped.filter((message) => message.messageId === messageIdFilter);
  }
  if (messageIdFilter && Array.isArray(messageIdFilter.$in)) {
    const idSet = new Set(messageIdFilter.$in);
    return mapped.filter((message) => idSet.has(message.messageId));
  }
  return mapped;
}

/**
 * Fetches one message by id. Mirrors Mongo's
 * `getMessage({user, messageId})` signature with `token` appended.
 *
 * When `conversationId` IS supplied (an optional addition over Mongo's
 * shape — several call sites already know it), this goes straight to that
 * conversation's message tree. When it is ABSENT — Mongo's own bare,
 * globally-unique `messageId` lookup, which WU-1's per-conversation API
 * has no direct equivalent for — this instead scans the CALLER'S OWN
 * conversations (`collectAllConversationIds`, token-scoped throughout,
 * never another user's data) for the first one containing a matching
 * message. Bounded by the caller's own conversation count, not a global
 * table scan; still O(n) in the worst case (message not found at all) —
 * an accepted, documented cost for correctness over a route
 * (`routes/messages.js`'s `POST /branch`/`POST /artifact/:messageId`)
 * that only ever has a bare `messageId` to start from.
 *
 * @param {{user?: string, messageId: string, conversationId?: string}} params
 * @param {string|null|undefined} token
 * @returns {Promise<Record<string, unknown>|null>}
 */
async function getMessage(params, token) {
  const { user, messageId, conversationId } = params || {};
  if (typeof messageId !== 'string' || messageId.length === 0) {
    throw new SovereignMemoryError(
      'getMessage requires messageId to route to the sovereign store',
      400,
    );
  }
  if (typeof conversationId === 'string' && conversationId.length > 0) {
    const messages = await getMessages(
      { conversationId, messageId, user },
      undefined,
      undefined,
      token,
    );
    return messages[0] ?? null;
  }
  const conversationIds = await collectAllConversationIds(user, token);
  for (const oneConversationId of conversationIds) {
    const messages = await getMessages(
      { conversationId: oneConversationId, messageId, user },
      undefined,
      undefined,
      token,
    );
    if (messages.length > 0) {
      return messages[0];
    }
  }
  return null;
}

/**
 * Client-side cursor pagination over one conversation's message tree.
 * Mirrors Mongo's `getMessagesByCursor(filter, options)` signature with
 * `token` appended.
 *
 * WU-1's message-tree endpoint returns the WHOLE conversation, chronological
 * ascending, with no native sort/cursor/limit — this fetches the full list
 * via `getMessages` and paginates/sorts it LOCALLY. The opaque `cursor` is
 * simply the numeric offset of the next page as a string; a caller only
 * ever round-trips a cursor this function issued. Documented v1
 * simplification: correct for a single conversation's message count (not
 * a global collection scan), inefficient only in the theoretical case of
 * an enormous single conversation.
 *
 * @param {{conversationId?: string, user?: string}} filter
 * @param {{sortField?: string, sortOrder?: 1|-1, limit?: number, cursor?: string|null}} [options]
 * @param {string|null|undefined} token
 * @returns {Promise<{messages: Record<string, unknown>[], nextCursor: string|null}>}
 */
async function getMessagesByCursor(filter, options = {}, token) {
  const conversationId = filter && filter.conversationId;
  if (typeof conversationId !== 'string' || conversationId.length === 0) {
    throw new SovereignMemoryError(
      'getMessagesByCursor requires filter.conversationId to route to the sovereign store',
      400,
    );
  }
  const all = await getMessages(filter, undefined, undefined, token);
  const sortField = ['createdAt', 'endpoint'].includes(options.sortField)
    ? options.sortField
    : 'createdAt';
  const sortOrder = options.sortOrder === 1 ? 1 : -1;
  const sorted = [...all].sort((a, b) => {
    const av = a[sortField] ?? '';
    const bv = b[sortField] ?? '';
    if (av < bv) {
      return -sortOrder;
    }
    if (av > bv) {
      return sortOrder;
    }
    return 0;
  });
  const offset = options.cursor ? parseInt(options.cursor, 10) || 0 : 0;
  const limit =
    options.limit && options.limit > 0 ? options.limit : DEFAULT_MESSAGES_BY_CURSOR_LIMIT;
  const page = sorted.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const nextCursor = nextOffset < sorted.length ? String(nextOffset) : null;
  return { messages: page, nextCursor };
}

/**
 * Deletes message(s). Mirrors Mongo's `deleteMessages(filter)` signature
 * with `token` appended.
 *
 * `filter.conversationId` + `filter.messageId` BOTH present (a string)
 * deletes exactly that one message — the single-message-delete route's
 * shape. Otherwise WU-1 exposes only a single-message DELETE (no
 * bulk-by-conversation endpoint), so this resolves the target conversation
 * id(s) the SAME way `deleteConvos` does, lists each conversation's
 * messages, and deletes them one at a time. A 404 per-message is tolerated
 * (already gone); any other non-2xx is fail-closed.
 *
 * @param {{conversationId?: string|{$in?: string[]}, messageId?: string, user?: string}} filter
 * @param {string|null|undefined} token
 * @returns {Promise<{deletedCount: number}>}
 */
async function deleteMessages(filter, token) {
  const conversationId = filter && filter.conversationId;
  const messageId = filter && filter.messageId;
  if (
    typeof conversationId === 'string' &&
    conversationId.length > 0 &&
    typeof messageId === 'string' &&
    messageId.length > 0
  ) {
    try {
      await callConsoleConversationsProxy({
        method: 'DELETE',
        path: `${conversationId}/messages/${messageId}`,
        token,
      });
      return { deletedCount: 1 };
    } catch (error) {
      if (isNotFound(error)) {
        return { deletedCount: 0 };
      }
      throw error;
    }
  }
  const explicitIds = extractIdList(conversationId);
  const ids = explicitIds ?? (await collectAllConversationIds(filter && filter.user, token));
  let deletedCount = 0;
  for (const oneConversationId of ids) {
    const messages = await getMessages(
      { conversationId: oneConversationId },
      undefined,
      undefined,
      token,
    );
    for (const message of messages) {
      try {
        await callConsoleConversationsProxy({
          method: 'DELETE',
          path: `${oneConversationId}/messages/${message.messageId}`,
          token,
        });
        deletedCount += 1;
      } catch (error) {
        if (isNotFound(error)) {
          continue;
        }
        throw error;
      }
    }
  }
  return { deletedCount };
}

/**
 * Bulk-creates conversations. Mirrors Mongo's
 * `bulkSaveConvos(conversations)` signature with `token` appended.
 *
 * WU-1 has no bulk-upsert endpoint, so this fans out to individual
 * `saveConvo` calls (each already fetch-then-merge safe — see the module
 * docstring's "Metadata-clobber guard"). Used by
 * `utils/import/importBatchBuilder.js::saveBatch` (fork/duplicate/import).
 * A single failed item is fail-closed: `Promise.all` rejects the whole
 * call on the first error, matching Mongo's own bulk-write's
 * all-or-nothing-per-batch discipline closely enough for this WU (WU-1 has
 * no bulk-write transaction semantics to match exactly either way).
 *
 * @param {Array<{conversationId: string, [key: string]: unknown}>} conversations
 * @param {string|null|undefined} token
 * @returns {Promise<{ok: true, count: number}>}
 */
async function bulkSaveConvos(conversations, token) {
  const items = Array.isArray(conversations) ? conversations : [];
  const results = await Promise.all(
    items.map((convo) =>
      saveConvo({ userId: convo.user, isTemporary: convo.isTemporary }, convo, undefined, token),
    ),
  );
  return { ok: true, count: results.length };
}

/**
 * Bulk-creates messages. Mirrors Mongo's
 * `bulkSaveMessages(messages, overrideTimestamp)` signature with `token`
 * appended. Fans out to individual `saveMessage` calls — see
 * `bulkSaveConvos`'s docstring for the same "no bulk endpoint" rationale.
 *
 * @param {Array<{conversationId: string, messageId: string, [key: string]: unknown}>} messages
 * @param {boolean} [_overrideTimestamp] - accepted for signature parity;
 *   WU-1's message row has no separate "override timestamp" concept.
 * @param {string|null|undefined} token
 * @returns {Promise<{ok: true, count: number}>}
 */
async function bulkSaveMessages(messages, _overrideTimestamp, token) {
  const items = Array.isArray(messages) ? messages : [];
  const results = await Promise.all(
    items.map((message) => saveMessage({ userId: message.user }, message, undefined, token)),
  );
  return { ok: true, count: results.length };
}

/**
 * One binder per shimmed method name: given the bound `token`, returns a
 * function with the EXACT positional arity Mongo callers use for that
 * name. Deliberately NOT a generic `(...args) => fn(...args, token)`
 * spread (the pre-remediation design) — different call sites invoke the
 * SAME method name with different argument counts (e.g. `deleteConvos` is
 * called both as `(user, filter)` and `(user, filter, options)`), and a
 * positional token appended after a variable-length spread would land in
 * the wrong parameter slot whenever a call site omits a trailing optional
 * argument. Each binder here declares its own fixed parameter list, so
 * `token` always lands in the same place regardless of how many optional
 * arguments any particular call site passes.
 */
const SOVEREIGN_METHOD_BINDERS = {
  saveConvo: (token) => (ctx, data, metadata) => saveConvo(ctx, data, metadata, token),
  getConvosByCursor: (token) => (user, options) => getConvosByCursor(user, options, token),
  getConvo: (token) => (user, conversationId) => getConvo(user, conversationId, token),
  getConvoOwnership: (token) => (user, conversationId) => getConvo(user, conversationId, token),
  setConvoPinned: (token) => (user, conversationId, pinned) =>
    setConvoPinned(user, conversationId, pinned, token),
  deleteConvos: (token) => (user, filter, options) => deleteConvos(user, filter, options, token),
  saveMessage: (token) => (ctx, params, metadata) => saveMessage(ctx, params, metadata, token),
  updateMessage: (token) => (userId, message, metadata) =>
    updateMessage(userId, message, metadata, token),
  getMessages: (token) => (filter, select, options) => getMessages(filter, select, options, token),
  getMessagesByCursor: (token) => (filter, options) => getMessagesByCursor(filter, options, token),
  getMessage: (token) => (params) => getMessage(params, token),
  deleteMessages: (token) => (filter) => deleteMessages(filter, token),
  bulkSaveConvos: (token) => (conversations) => bulkSaveConvos(conversations, token),
  bulkSaveMessages: (token) => (messages, overrideTimestamp) =>
    bulkSaveMessages(messages, overrideTimestamp, token),
};

/**
 * THE CHOKEPOINT (MongoDB-elimination WU-2b — the model-layer pivot,
 * 2026-09-11, RATIFIED after three route-level-wiring REJECTs). Wraps
 * EVERY method in `mongoMethods` that has a `SOVEREIGN_METHOD_BINDERS`
 * entry with a function that decides, AT CALL TIME (not at wrap time),
 * which backend serves THIS call:
 *
 *   `isSovereignBackend()` AND a live request access token
 *   (`getRequestAccessToken()`, from `./requestContext`) → the sovereign
 *   adapter, fail-closed; else → the raw Mongo function, UNCHANGED.
 *
 * This is called EXACTLY ONCE, in `api/models/index.js`, wrapping the
 * FULL `createMethods(...)` output before it is exported. Because every
 * caller in the fork — routes, controllers, `utils/import/fork.js`
 * (`const db = require('~/models')`), `services/Schedules/index.js`
 * (`createSchedulesService({ methods: require('~/models'), ... })`), and
 * any future caller — obtains these same wrapped function references
 * (there is no OTHER path to `saveConvo`/`getMessages`/etc.), sovereign
 * routing is now STRUCTURALLY complete: no request-scoped caller can
 * bypass it, by construction, not by enumeration. This is what closed
 * the completeness gap three rounds of route-level wiring could not
 * (each round's exhaustive grep found another caller — fork/duplicate/
 * import, then `services/Schedules/index.js` threading `~/models` as an
 * injected `methods` param — because NAME-BASED enumeration of call
 * sites can always miss one; wrapping the single EXPORT point cannot).
 *
 * **The one honest, disclosed boundary:** a scheduled/triggered
 * conversation write that fires with NO live HTTP request (a genuine
 * cron-style background execution, as opposed to a "run now" fired
 * synchronously within a user's request) has no `getRequestAccessToken()`
 * value to read — `undefined` — so it falls to Mongo, `isSovereignBackend()`
 * or not. This is intentional and documented, not a gap this WU could
 * close without inventing a service-delegation/service-token mechanism
 * (explicitly out of scope — see the ratified spec's "Out of scope").
 * `AuditTraceConversations`/the chokepoint NEVER fabricates a token to
 * force a background write through.
 *
 * A `mongoMethods` key with no `SOVEREIGN_METHOD_BINDERS` entry (every
 * OTHER `~/models` export — users, presets, roles, files, agent-event
 * actors, subagent threads, …) is returned unchanged; this function only
 * ever touches the named conversation/message methods.
 *
 * @param {Record<string, Function>} mongoMethods - the FULL `createMethods(...)`
 *   output (or any object containing some of the same-named methods).
 * @returns {Record<string, Function>} a new object, same keys as
 *   `mongoMethods`, with the chokepointed names replaced by
 *   call-time-dispatching wrappers.
 */
function wrapModelMethods(mongoMethods) {
  const wrapped = { ...mongoMethods };
  for (const name of Object.keys(SOVEREIGN_METHOD_BINDERS)) {
    const mongoFn = mongoMethods[name];
    if (typeof mongoFn !== 'function') {
      continue;
    }
    const binder = SOVEREIGN_METHOD_BINDERS[name];
    wrapped[name] = (...args) => {
      const token = isSovereignBackend() ? getRequestAccessToken() : undefined;
      if (token) {
        return binder(token)(...args);
      }
      return mongoFn(...args);
    };
  }
  return wrapped;
}

module.exports = {
  saveConvo,
  getConvosByCursor,
  getConvo,
  setConvoPinned,
  deleteConvos,
  saveMessage,
  updateMessage,
  getMessages,
  getMessagesByCursor,
  getMessage,
  deleteMessages,
  bulkSaveConvos,
  bulkSaveMessages,
  wrapModelMethods,
  // Exported for direct unit testing, not part of the MethodsShaped surface.
  _internal: { extractIdList, collectAllConversationIds, fetchRawMessageItem, convoExtraMetadata },
};
