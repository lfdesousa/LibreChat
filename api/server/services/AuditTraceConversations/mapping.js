/**
 * Pure LibreChat <-> `/console/conversations` field mapping (WU-2, per the
 * ratified spec's "Mapping" section). No I/O, no token — kept separate
 * from `index.js` so the shape translation is independently testable,
 * mirroring `AuditTraceMemory/keyMapping.js`'s split.
 *
 * **v1 simplification (documented, matching the memory adapter's own
 * "agent-partitioned memories deferred" precedent):** WU-1's
 * `ConsoleConversationUpsertRequest`/`ConsoleMessageUpsertRequest` are a
 * SIMPLER shape than this fork's enterprise `IConversation`/`IMessage`
 * (no `isArchived`/`pinned`/`tags` fields, no agent-event-actor/subagent
 * fields at all). Rather than silently dropping `isArchived`/`pinned`/
 * `tags` on a sovereign write, they are round-tripped through the API's
 * generic `metadata` bag — recoverable, not reconstructed as first-class
 * filters (WU-1's `GET /console/conversations` has no `isArchived`/
 * `pinned`/`tags`/`search`/`sortBy` query params yet, so those
 * `getConvosByCursor` options are accepted-but-ignored, exactly like the
 * memory adapter's `agentId`-accepted-but-ignored precedent in
 * `AuditTraceMemory/index.js::getUserMemories`). The much larger
 * agent-event-actor / subagent-thread / HITL surface on `IConversation`/
 * `IMessage` is OUT OF SCOPE for this WU entirely — not read, not
 * written, not round-tripped.
 */

/** @param {unknown} v @returns {boolean} */
function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Builds the `metadata` bag for a conversation upsert, carrying the
 * fields WU-1's API has no first-class column for.
 *
 * @param {{isArchived?: boolean, pinned?: boolean, tags?: string[]}} data
 * @returns {Record<string, unknown>}
 */
function convoExtraMetadata(data) {
  const out = {};
  if (data.isArchived !== undefined) {
    out.isArchived = Boolean(data.isArchived);
  }
  if (data.pinned !== undefined) {
    out.pinned = Boolean(data.pinned);
  }
  if (Array.isArray(data.tags)) {
    out.tags = data.tags;
  }
  return out;
}

/**
 * Maps a `saveConvo(ctx, data, metadata)` call onto
 * `ConsoleConversationUpsertRequest`'s shape.
 *
 * @param {{isTemporary?: boolean}} ctx
 * @param {{conversationId: string, title?: string, endpoint?: string, model?: string,
 *   agent_id?: string, chatProjectId?: string, isArchived?: boolean, pinned?: boolean,
 *   tags?: string[]}} data
 * @returns {Record<string, unknown>}
 */
function convoUpsertBody(ctx, data) {
  const body = {
    conversation_id: data.conversationId,
    is_temporary: Boolean(ctx && ctx.isTemporary),
    metadata: convoExtraMetadata(data),
  };
  if (data.title !== undefined) {
    body.title = data.title;
  }
  if (data.endpoint !== undefined) {
    body.endpoint = data.endpoint;
  }
  if (data.model !== undefined) {
    body.model = data.model;
  }
  if (data.agent_id !== undefined) {
    body.agent_id = data.agent_id;
  }
  if (data.chatProjectId !== undefined) {
    body.chat_project_id = data.chatProjectId;
  }
  return body;
}

/**
 * Maps a `ConsoleConversationItem` response row back onto the
 * LibreChat-shaped conversation object callers expect from
 * `getConvo`/`getConvosByCursor`/`saveConvo`.
 *
 * @param {Record<string, unknown>} item
 * @param {string} [userId]
 * @returns {Record<string, unknown>}
 */
function apiToConvo(item, userId) {
  const metadata = isPlainObject(item.metadata) ? item.metadata : {};
  const convo = {
    conversationId: item.conversation_id,
    title: item.title,
    endpoint: item.endpoint ?? null,
    model: item.model ?? null,
    isTemporary: Boolean(item.is_temporary),
    agent_id: item.agent_id ?? undefined,
    chatProjectId: item.chat_project_id ?? undefined,
    user: userId,
    createdAt: new Date(item.created_at_ms).toISOString(),
    updatedAt: new Date(item.updated_at_ms).toISOString(),
  };
  if (metadata.isArchived !== undefined) {
    convo.isArchived = Boolean(metadata.isArchived);
  }
  if (metadata.pinned !== undefined) {
    convo.pinned = Boolean(metadata.pinned);
  }
  if (Array.isArray(metadata.tags)) {
    convo.tags = metadata.tags;
  }
  return convo;
}

/**
 * Maps a `saveMessage(ctx, params, metadata)` call onto
 * `ConsoleMessageUpsertRequest`'s shape.
 *
 * `error` is lossy: the fork's `IMessage.error` is a boolean flag, WU-1's
 * `error` column is a free-text string — a `true` flag round-trips as the
 * literal string `"true"` rather than losing the signal entirely (an
 * explicit, documented v1 simplification, same discipline as the class
 * docstring above).
 *
 * @param {{messageId: string, conversationId: string, parentMessageId?: string|null,
 *   sender?: string, text?: string, isCreatedByUser?: boolean, model?: string,
 *   endpoint?: string, tokenCount?: number, error?: boolean|string}} params
 * @returns {Record<string, unknown>}
 */
function messageUpsertBody(params) {
  const body = {
    message_id: params.messageId,
    sender: params.sender || (params.isCreatedByUser ? 'User' : 'AI'),
    text: params.text ?? '',
    is_created_by_user: Boolean(params.isCreatedByUser),
    metadata: {},
  };
  if (params.parentMessageId !== undefined && params.parentMessageId !== null) {
    body.parent_message_id = params.parentMessageId;
  }
  if (params.model !== undefined) {
    body.model = params.model;
  }
  if (params.endpoint !== undefined) {
    body.endpoint = params.endpoint;
  }
  if (params.tokenCount !== undefined) {
    body.token_count = params.tokenCount;
  }
  if (params.error) {
    body.error = typeof params.error === 'string' ? params.error : 'true';
  }
  return body;
}

/**
 * Maps a `ConsoleMessageItem` response row back onto the LibreChat-shaped
 * message object callers expect from `getMessage`/`getMessages`/
 * `saveMessage`/`updateMessage`.
 *
 * @param {Record<string, unknown>} item
 * @param {string} [userId]
 * @returns {Record<string, unknown>}
 */
function apiToMessage(item, userId) {
  return {
    messageId: item.message_id,
    conversationId: item.conversation_id,
    parentMessageId: item.parent_message_id ?? null,
    sender: item.sender,
    text: item.text,
    isCreatedByUser: Boolean(item.is_created_by_user),
    model: item.model ?? undefined,
    endpoint: item.endpoint ?? undefined,
    tokenCount: item.token_count ?? undefined,
    error: Boolean(item.error),
    user: userId,
    createdAt: new Date(item.created_at_ms).toISOString(),
  };
}

module.exports = {
  convoUpsertBody,
  apiToConvo,
  messageUpsertBody,
  apiToMessage,
};
