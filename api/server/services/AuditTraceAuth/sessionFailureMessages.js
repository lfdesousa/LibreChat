/**
 * The four named failures of a long turn's token refresh (operator ruling "Expired vs ended",
 * 2026-11-25) and the text the user sees for each. The texts are distinct, token-free, and
 * each says the audit record is complete (the memory server writes it from the exchanged
 * token at chat completion; the fork's save path cannot reach it).
 */

const SESSION_EXPIRED = 'sovereign_session_expired';
const SSO_SESSION_ENDED = 'sovereign_sso_session_ended';
const REFRESH_TOKEN_REJECTED = 'sovereign_refresh_token_rejected';
const REFRESH_FAILED = 'sovereign_refresh_failed';

const SOVEREIGN_SESSION_FAILURE_CODES = Object.freeze([
  SESSION_EXPIRED,
  SSO_SESSION_ENDED,
  REFRESH_TOKEN_REJECTED,
  REFRESH_FAILED,
]);

const MESSAGES = Object.freeze({
  [SESSION_EXPIRED]: {
    title: 'Sign-in time limit reached',
    text: 'Your sign-in reached its time limit before this answer could be saved. The audit record is complete; sign in again and reload.',
  },
  [SSO_SESSION_ENDED]: {
    title: 'Sign-in ended elsewhere',
    text: 'Your sign-in was ended elsewhere (an administrator or another sign-out) before this answer could be saved. The audit record is complete; sign in again.',
  },
  [REFRESH_TOKEN_REJECTED]: {
    title: 'Sign-in could not be renewed',
    text: 'Your sign-in could not be renewed. The audit record is complete; sign out and sign in again.',
  },
  [REFRESH_FAILED]: {
    title: 'Sign-in service unavailable',
    text: 'The sign-in service could not be reached, so this answer was not saved. The audit record is complete; try again in a moment.',
  },
});

const GENERIC = Object.freeze({
  title: 'Generation failed',
  text: 'Generation failed',
});

/**
 * @param {string|undefined} code
 * @returns {{code: string|undefined, title: string, text: string}}
 */
function messageForSovereignFailure(code) {
  const message = Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : GENERIC;
  return { code, title: message.title, text: message.text };
}

/**
 * @param {unknown} error
 * @returns {boolean} true for an error carrying one of the four operator-named codes
 */
function isSovereignSessionFailure(error) {
  return SOVEREIGN_SESSION_FAILURE_CODES.includes(/** @type {any} */ (error)?.code);
}

module.exports = {
  SESSION_EXPIRED,
  SSO_SESSION_ENDED,
  REFRESH_TOKEN_REJECTED,
  REFRESH_FAILED,
  SOVEREIGN_SESSION_FAILURE_CODES,
  messageForSovereignFailure,
  isSovereignSessionFailure,
};
