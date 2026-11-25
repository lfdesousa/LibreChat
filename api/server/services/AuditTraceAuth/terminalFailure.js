const { logger } = require('@librechat/data-schemas');
const {
  isSovereignSessionFailure,
  messageForSovereignFailure,
} = require('./sessionFailureMessages');

/**
 * The terminal-persistence path of a resumable turn (`agents/request.js`) calls this with the
 * error it caught. A named sovereign session failure is logged by code (never a token) and
 * emitted to the client as a visible error carrying the code and the user text; the partial
 * checkpoint and the audit record are not touched here, so nothing is lost silently.
 *
 * @param {object} params
 * @param {unknown} params.error
 * @param {string} params.streamId
 * @param {number|undefined} params.jobCreatedAt
 * @param {{emitError: (streamId: string, error: string, createdAt?: number) => Promise<void>}} params.manager
 * @returns {Promise<boolean>} true when the error was a named session failure and was surfaced
 */
async function handleSovereignTerminalFailure({ error, streamId, jobCreatedAt, manager }) {
  if (!isSovereignSessionFailure(error)) {
    return false;
  }
  const { code, text } = messageForSovereignFailure(/** @type {any} */ (error).code);
  logger.error(`[ResumableAgentController] Terminal persistence refused (${code}) for ${streamId}`);
  try {
    await manager.emitError(streamId, `${text} (${code})`, jobCreatedAt);
  } catch (emitError) {
    logger.warn(
      `[ResumableAgentController] Could not emit the session failure (${code}) for ${streamId}`,
      emitError,
    );
  }
  return true;
}

module.exports = { handleSovereignTerminalFailure };
