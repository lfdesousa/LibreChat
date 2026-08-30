/**
 * Error types for the sovereign memory adapter (M3-WU-D2-2).
 *
 * A single `SovereignMemoryError` carries the HTTP status the route layer
 * (`api/server/routes/memories.js`) should reply with — every non-2xx
 * outcome of the adapter (missing token, read-only-layer write, an
 * upstream 401/403/404/502 relayed byte-faithfully by the BFF) is this one
 * type, distinguished only by `.status`. Route handlers never have to
 * guess a status code from a message string.
 */

class SovereignMemoryError extends Error {
  /**
   * @param {string} message
   * @param {number} status - HTTP status the caller should respond with.
   */
  constructor(message, status) {
    super(message);
    this.name = 'SovereignMemoryError';
    this.status = status;
  }
}

/** No usable access token — the adapter never calls the BFF in this case
 *  (fail-closed: absent token can only ever mean 401, never a guess). */
class MissingAccessTokenError extends SovereignMemoryError {
  constructor(message = 'No sovereign-memory access token on the session.') {
    super(message, 401);
    this.name = 'MissingAccessTokenError';
  }
}

/** A create/update/delete targeted a read-only layer (episodic,
 *  conversational) or a corpus-tier item — rejected locally, never
 *  forwarded to the BFF (protects the audit trail). */
class ReadOnlyLayerError extends SovereignMemoryError {
  constructor(message) {
    super(message, 403);
    this.name = 'ReadOnlyLayerError';
  }
}

/** The composite key `{layer}:{native_ref}` did not parse to a known
 *  layer — a caller-crafted or corrupted key, never a server bug. */
class InvalidCompositeKeyError extends SovereignMemoryError {
  constructor(message) {
    super(message, 400);
    this.name = 'InvalidCompositeKeyError';
  }
}

module.exports = {
  SovereignMemoryError,
  MissingAccessTokenError,
  ReadOnlyLayerError,
  InvalidCompositeKeyError,
};
