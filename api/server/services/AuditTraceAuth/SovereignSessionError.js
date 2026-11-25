const { SovereignMemoryError } = require('../AuditTraceMemory/errors');

/**
 * A hard-limit failure of the user's sign-in, raised by the request token source
 * (`tokenSource.js`) when it cannot keep the access token fresh. It extends
 * `SovereignMemoryError` so every existing sovereign catch site (routes, the
 * chokepoint callers) maps `.status` unchanged.
 *
 * `message` never carries a token or a Keycloak body; `code` is one of the four
 * operator-named codes (`sessionFailureMessages.js`), `detail` a short machine reason.
 */
class SovereignSessionError extends SovereignMemoryError {
  /**
   * @param {{code: string, status: number, detail?: string}} params
   */
  constructor({ code, status, detail }) {
    super(`sovereign session failure: ${code}${detail ? ` (${detail})` : ''}`, status);
    this.name = 'SovereignSessionError';
    this.code = code;
    this.detail = detail;
  }
}

module.exports = { SovereignSessionError };
