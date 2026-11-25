/**
 * CONSOLE-LONG-TURN-TOKEN-REFRESH ADDENDUM-1 — A6 / AC-7: the terminal path names its failure to the user.
 *
 * Contract pinned: `api/server/services/AuditTraceAuth/sessionFailureMessages.js` exports
 * `messageForSovereignFailure(code)` → `{ code, title, text }` with a DISTINCT text per operator code
 * (S1 ruling "Expired vs ended") and `isSovereignSessionFailure(error)`; `ResumableAgentController`
 * (agents/request.js:2814) uses them to log `Terminal persistence refused (<code>)` and to emit the
 * error event the client shows. RED today: the module does not exist.
 * Neuter: return the generic 'Generation failed' text for every code → the distinctness assertions RED.
 */
const CODES = [
  'sovereign_session_expired',
  'sovereign_sso_session_ended',
  'sovereign_refresh_token_rejected',
  'sovereign_refresh_failed',
];

describe('CONSOLE-LONG-TURN-TOKEN-REFRESH ADDENDUM-1 — user-visible messages per failure code', () => {
  it('R18 — one distinct, token-free, audit-record-naming message per code; unknown codes get the generic text', () => {
    let mod;
    expect(() => {
      mod = require('~/server/services/AuditTraceAuth/sessionFailureMessages');
    }).not.toThrow();
    const { messageForSovereignFailure, isSovereignSessionFailure } = mod;
    const texts = CODES.map((code) => {
      const m = messageForSovereignFailure(code);
      expect(m.code).toBe(code);
      expect(typeof m.title).toBe('string');
      expect(typeof m.text).toBe('string');
      expect(m.text).toMatch(/audit record/i); // the record is complete: say so
      expect(m.text).not.toMatch(/Bearer|eyJ/); // never a token
      return m.text;
    });
    expect(new Set(texts).size).toBe(CODES.length);
    expect(messageForSovereignFailure('something_else').text).not.toBe(texts[0]);
    expect(isSovereignSessionFailure(Object.assign(new Error('x'), { code: CODES[0] }))).toBe(true);
    expect(isSovereignSessionFailure(new Error('Generation failed'))).toBe(false);
  });
});
