/**
 * Shared derivation of a NEW chat's conversation id from the client's
 * per-submission seed (`clientRequestId`).
 *
 * The agents controller (`request.js`) mints a new chat's conversation id as
 * `uuidv5(`${userId}:${clientRequestId}`, NAMESPACE)`; the file-upload path
 * (`crud.js`) derives the SAME id for an attachment uploaded before the chat
 * exists, so the upload's `X-Session-Id` equals the id the chat is later
 * created under (LC-10a, A'). One pure function, one namespace: a divergence
 * would silently split a chat's attachments from the chat.
 *
 * The derivation is a correctness device, never an authorization input: the
 * trust boundary stays `userId`.
 */
const { v5: uuidv5 } = require('uuid');

const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;

/** New-chat retries do not carry a conversation id, so derive the stream id
 * from their stable per-submission id. This keeps both the dedupe key and the
 * Redis hash slot identical across a lost-response retry. */
const NEW_CONVERSATION_IDEMPOTENCY_NAMESPACE = 'd7f2518c-94b8-4fe8-97ad-2d4bdb2c9f43';

/**
 * @param {string} userId
 * @param {string} clientRequestId
 * @returns {string}
 */
function deriveNewConversationId(userId, clientRequestId) {
  return uuidv5(`${userId}:${clientRequestId}`, NEW_CONVERSATION_IDEMPOTENCY_NAMESPACE);
}

module.exports = {
  CLIENT_REQUEST_ID_PATTERN,
  NEW_CONVERSATION_IDEMPOTENCY_NAMESPACE,
  deriveNewConversationId,
};
