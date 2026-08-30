/**
 * Config for the sovereign memory adapter (M3-WU-D2-2).
 *
 * Portability invariant: every target-shaped value (the BFF's base URL,
 * the request timeout) sits behind an env var with a laptop-safe default
 * — never a hardcoded target in the adapter logic itself. `getConfig()`
 * re-reads `process.env` on every call (not memoized) so tests can flip
 * `AUDITTRACE_MEMORY_BACKEND` per-`it()` without a module-cache dance.
 */

const DEFAULT_BFF_BASE_URL = 'http://localhost:8766';
const DEFAULT_TIMEOUT_MS = 15000;

/**
 * @returns {{backend: 'mongo'|'sovereign', bffBaseUrl: string, timeoutMs: number}}
 */
function getConfig() {
  const backend = process.env.AUDITTRACE_MEMORY_BACKEND === 'sovereign' ? 'sovereign' : 'mongo';
  const bffBaseUrl = process.env.AUDITTRACE_BFF_BASE_URL || DEFAULT_BFF_BASE_URL;
  const parsedTimeout = Number(process.env.AUDITTRACE_BFF_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : DEFAULT_TIMEOUT_MS;
  return { backend, bffBaseUrl, timeoutMs };
}

/** `true` iff the sovereign backend is selected — anything other than the
 *  literal string `"sovereign"` (unset, `"mongo"`, a typo) fails closed to
 *  the legacy Mongo path, never the other way round. */
function isSovereignBackend() {
  return getConfig().backend === 'sovereign';
}

module.exports = { getConfig, isSovereignBackend };
