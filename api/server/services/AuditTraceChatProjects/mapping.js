/**
 * Pure LibreChat <-> `/console/chat-projects` field mapping
 * (MongoDB-elimination WU-chatprojects — the THIRD reuse of the WU-2b
 * model-layer-chokepoint pattern). No I/O, no token — kept separate from
 * `index.js` so the shape translation is independently testable,
 * mirroring `AuditTracePresets/mapping.js`'s split.
 *
 * **Shape.** `ConsoleChatProjectItem` (`services/console_chat_projects.py`
 * in AuditTrace-AI) has first-class columns for `name`/`description` plus
 * a generic `metadata` bag — a single flat resource, no group+versions
 * split (unlike prompts) and no open-ended per-endpoint config blob
 * (unlike presets).
 *
 * **Disclosed v1 simplification — `conversationCount`/`lastConversationAt`/
 * `lastConversationId` are ALWAYS `0`/`null`/`null`, never sourced from
 * `metadata` or computed.** LibreChat's Mongo `IChatProject` recomputes
 * these fields by counting/joining the caller's `Conversation` documents
 * (`refreshChatProjectStatsForUser`/`updateChatProjectLastConversationForUser`
 * in `packages/data-schemas/src/methods/chatProject.ts`, called from
 * `conversation.ts`'s OWN Mongo methods). The ratified spec is explicit
 * that this WU maps chat-project CRUD ONLY and must NOT re-wire
 * conversation<->project linkage (that stays the conversations shim's
 * domain — see `index.js`'s module docstring). Rather than fabricate a
 * plausible-looking count this adapter never keeps in sync (which would
 * look like correct wiring while silently being wrong — the same
 * reasoning `AuditTracePrompts/index.js`'s "orphaned exports" category
 * gives for NOT binding a method with no faithful sovereign
 * implementation), every wired method here returns the honest "not
 * tracked" zero-value for these three fields. `metadata` is round-tripped
 * unchanged for forward-compatibility but this adapter never writes
 * anything into it.
 */

/** @param {unknown} v @returns {boolean} */
function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Builds the `ConsoleChatProjectUpsertRequest` body.
 *
 * @param {string} chatProjectId
 * @param {{name: string, description?: string|null}} fields
 * @returns {Record<string, unknown>}
 */
function chatProjectUpsertBody(chatProjectId, { name, description }) {
  return {
    chat_project_id: chatProjectId,
    name,
    description: description ?? undefined,
  };
}

/**
 * Maps a `ConsoleChatProjectItem` onto the LibreChat `IChatProject` shape.
 * See this module's docstring for why `conversationCount`/
 * `lastConversationAt`/`lastConversationId` are always the "not tracked"
 * zero-value rather than sourced from the response.
 *
 * @param {Record<string, unknown>} item
 * @param {string} userId
 * @returns {Record<string, unknown>}
 */
function apiToProject(item, userId) {
  return {
    _id: item.chat_project_id,
    name: item.name,
    description: item.description,
    user: userId,
    conversationCount: 0,
    lastConversationAt: null,
    lastConversationId: null,
    createdAt: new Date(item.created_at_ms).toISOString(),
    updatedAt: new Date(item.updated_at_ms).toISOString(),
  };
}

module.exports = {
  isPlainObject,
  chatProjectUpsertBody,
  apiToProject,
};
