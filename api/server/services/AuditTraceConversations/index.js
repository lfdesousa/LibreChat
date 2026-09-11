/**
 * The sovereign-conversations adapter (MongoDB-elimination EPIC, WU-2) —
 * the 9 `~/models` conversation/message methods
 * (`packages/data-schemas/src/methods/{conversation,message}.ts`) LibreChat
 * calls for the console's persistence, backed by HTTP calls to the BFF
 * `/console/conversations/*` proxy (WU-1) instead of Mongo, gated behind
 * `AUDITTRACE_MEMORY_BACKEND=sovereign` (`../AuditTraceMemory/config`).
 *
 * Mirrors `AuditTraceMemory/index.js`'s structure and discipline
 * deliberately: **token threading is explicit, not ambient.** Every raw
 * function here takes a trailing `token` argument; `resolveConversationMethods`
 * (below) is the ONE seam a call site uses to bind that token from
 * `req.session.openidTokens.accessToken` once and get back an object whose
 * methods have the EXACT SAME call signature as the Mongo model functions
 * they replace — the same "explicit-threading, resolver-bound" pattern
 * `AuditTraceMemory/agentMethods.js::resolveMemoryWriteMethods` already
 * established for the agent memory-write seam. There is no
 * AsyncLocalStorage, no module-level "current user".
 *
 * **Fail-closed, always.** A non-2xx from `callConsoleConversationsProxy`
 * (`SovereignMemoryError`) propagates to the caller unchanged — no method
 * here ever falls back to a Mongo call on error. The one place a
 * `SovereignMemoryError` is deliberately interpreted rather than
 * re-thrown is a 404 read (an absent/foreign conversation), which maps to
 * `null`/`[]` — the SAME "not found" semantics Mongo's own
 * `getConvo`/`getMessages` already have for a no-match query, not a
 * fail-open shortcut (no write path does this).
 *
 * **Scope (per the ratified spec):** only the 9 named methods are
 * shimmed. This fork's much larger agent-event-actor / subagent-thread /
 * HITL / chat-project / tenant surface on `~/models` is untouched — those
 * methods are not exported here and are not wrapped by
 * `resolveConversationMethods` (a `mongoMethods` object that never
 * includes them is returned as-is, sovereign or not).
 */

const { callConsoleConversationsProxy } = require('./client');
const { convoUpsertBody, apiToConvo, messageUpsertBody, apiToMessage } = require('./mapping');
const { SovereignMemoryError } = require('../AuditTraceMemory/errors');
const { isSovereignBackend } = require('../AuditTraceMemory/config');

const COLLECT_ALL_PAGE_SIZE = 100;

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
  const body = convoUpsertBody(ctx || {}, data);
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
 * Deletes the caller's own conversation(s). Mirrors Mongo's
 * `deleteConvos(user, filter)` signature with `token` appended.
 *
 * WU-1 only exposes a single-id `DELETE`, so this fans out: an explicit
 * `filter.conversationId` (a string or `{$in: [...]}`) deletes exactly
 * those ids; an empty/absent filter pages through every conversation the
 * caller owns first (`collectAllConversationIds`) and deletes each — the
 * "delete everything" case `routes/convos.js`'s `DELETE /all` uses. A 404
 * per-id (already deleted) is tolerated, matching delete-many's own
 * idempotent semantics; any other non-2xx is fail-closed (propagates).
 *
 * @param {string} user
 * @param {{conversationId?: string|{$in?: string[]}}} [filter]
 * @param {string|null|undefined} token
 * @returns {Promise<{deletedCount: number, conversationIds: string[]}>}
 */
async function deleteConvos(user, filter = {}, token) {
  const explicitIds = extractIdList(filter && filter.conversationId);
  const ids = explicitIds ?? (await collectAllConversationIds(user, token));
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
 * Edits the caller's own message. Mirrors Mongo's
 * `updateMessage(userId, message, metadata)` signature with `token`
 * appended. `message.conversationId` is REQUIRED — WU-1 addresses a
 * message by `{conversation_id}/messages/{message_id}`, unlike Mongo's
 * `_id`-addressable update; a caller that omits it gets a loud 400, never
 * a silent no-op.
 *
 * @param {string} userId
 * @param {{conversationId: string, messageId: string, text?: string, metadata?: Record<string, unknown>}} message
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
  const body = {};
  if (message.text !== undefined) {
    body.text = message.text;
  }
  if (message.metadata !== undefined) {
    body.metadata = message.metadata;
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
 * Returns the message tree for one conversation. Mirrors Mongo's
 * `getMessages(filter, select, options)` signature with `token` appended.
 *
 * `filter.conversationId` is REQUIRED — WU-1's API has no arbitrary
 * Mongo-filter query surface; a caller relying on some OTHER filter shape
 * gets a loud 400, never a silently-empty/wrong result. A 404 (conversation
 * not found/not owned) maps to `[]`, matching Mongo's own no-match
 * semantics for a filter query (not an error condition for a list read).
 *
 * @param {{conversationId?: string, user?: string}} filter
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
  try {
    const resp = await callConsoleConversationsProxy({
      method: 'GET',
      path: `${conversationId}/messages`,
      token,
    });
    const items = Array.isArray(resp && resp.items) ? resp.items : [];
    return items.map((item) => apiToMessage(item, filter.user));
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }
    throw error;
  }
}

/**
 * Fetches one message by id. Mirrors Mongo's
 * `getMessage({user, messageId})` signature with `token` appended and
 * `conversationId` REQUIRED on the params object — Mongo can look a
 * message up by its globally-unique `messageId` alone; WU-1 addresses a
 * message only within its conversation, so a caller that cannot supply
 * `conversationId` gets a loud 400 rather than a guess.
 *
 * @param {{user?: string, messageId: string, conversationId: string}} params
 * @param {string|null|undefined} token
 * @returns {Promise<Record<string, unknown>|null>}
 */
async function getMessage(params, token) {
  const { user, messageId, conversationId } = params || {};
  if (typeof conversationId !== 'string' || conversationId.length === 0) {
    throw new SovereignMemoryError(
      "getMessage requires conversationId to route to the sovereign store (Mongo's bare " +
        'messageId lookup has no sovereign equivalent)',
      400,
    );
  }
  const messages = await getMessages({ conversationId, user }, undefined, undefined, token);
  return messages.find((message) => message.messageId === messageId) ?? null;
}

/**
 * Deletes message(s). Mirrors Mongo's `deleteMessages(filter)` signature
 * with `token` appended.
 *
 * WU-1 exposes only a single-message DELETE (no bulk-by-conversation
 * endpoint), so this resolves the target conversation id(s) the SAME way
 * `deleteConvos` does, lists each conversation's messages, and deletes
 * them one at a time. A 404 per-message is tolerated (already gone);
 * any other non-2xx is fail-closed.
 *
 * @param {{conversationId?: string|{$in?: string[]}, user?: string}} filter
 * @param {string|null|undefined} token
 * @returns {Promise<{deletedCount: number}>}
 */
async function deleteMessages(filter, token) {
  const explicitIds = extractIdList(filter && filter.conversationId);
  const ids = explicitIds ?? (await collectAllConversationIds(filter && filter.user, token));
  let deletedCount = 0;
  for (const conversationId of ids) {
    const messages = await getMessages({ conversationId }, undefined, undefined, token);
    for (const message of messages) {
      try {
        await callConsoleConversationsProxy({
          method: 'DELETE',
          path: `${conversationId}/messages/${message.messageId}`,
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

const SOVEREIGN_METHODS = {
  saveConvo,
  getConvosByCursor,
  getConvo,
  deleteConvos,
  saveMessage,
  updateMessage,
  getMessages,
  getMessage,
  deleteMessages,
};

/**
 * Selects the conversation/message methods object a call site should use:
 * a sovereign bridge (token bound at construction from
 * `req.session.openidTokens.accessToken`) when
 * `AUDITTRACE_MEMORY_BACKEND=sovereign` is active, or `mongoMethods`
 * COMPLETELY UNCHANGED (same object reference) otherwise — the SAME
 * "explicit resolver seam" pattern
 * `AuditTraceMemory/agentMethods.js::resolveMemoryWriteMethods` already
 * established.
 *
 * `mongoMethods` may be a PARTIAL object naming only the methods a given
 * call site actually uses (e.g. `{ getConvo: db.getConvo }` in a route
 * that only reads one conversation) — only those same keys are bound on
 * the sovereign side, so an unrelated method never spuriously appears (or
 * disappears) on the returned object.
 *
 * @param {{req: {session?: {openidTokens?: {accessToken?: string}}}, mongoMethods: Record<string, Function>}} params
 * @returns {Record<string, Function>} `mongoMethods` (same reference)
 *   under the default `mongo` flag; a sovereign-bound object (same key
 *   set) otherwise.
 */
function resolveConversationMethods({ req, mongoMethods }) {
  if (!isSovereignBackend()) {
    return mongoMethods;
  }
  const token =
    (req && req.session && req.session.openidTokens && req.session.openidTokens.accessToken) ||
    null;
  const bound = {};
  for (const name of Object.keys(mongoMethods || {})) {
    const sovereignFn = SOVEREIGN_METHODS[name];
    if (!sovereignFn) {
      // Not one of the 9 shimmed methods — out of scope for this WU;
      // pass the caller's own (Mongo) function through unchanged rather
      // than silently dropping it.
      bound[name] = mongoMethods[name];
      continue;
    }
    bound[name] = (...args) => sovereignFn(...args, token);
  }
  return bound;
}

module.exports = {
  saveConvo,
  getConvosByCursor,
  getConvo,
  deleteConvos,
  saveMessage,
  updateMessage,
  getMessages,
  getMessage,
  deleteMessages,
  resolveConversationMethods,
  // Exported for direct unit testing, not part of the MethodsShaped surface.
  _internal: { extractIdList, collectAllConversationIds },
};
