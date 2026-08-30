/**
 * Composite-key mapping between LibreChat's `{key,value}` memory entry and
 * our layered memory (M3-WU-D2-2).
 *
 * `key` round-trips through the layer/native-ref split below:
 *   `{layer}:{native_ref}` — native_ref is the filename for episodic /
 *   procedural, `{collection}/{document_id}` for semantic, and the
 *   session id for conversational (see
 *   `src/audittrace/routes/memory.py::_semantic_key`, verified
 *   2026-08-30, for the semantic native_ref shape this mirrors).
 */

const LAYERS = Object.freeze(['episodic', 'procedural', 'semantic', 'conversational']);

/** Layers a console write can ever target. Episodic (the audit trail
 *  itself) and conversational (RLS-owned session history) are ALWAYS
 *  read-only, independent of tier — this is not a UI nicety, it is
 *  enforced below in `isReadOnly` / the adapter's write paths. */
const WRITABLE_LAYERS = Object.freeze(['semantic', 'procedural']);

/** Default semantic collection a bare (unprefixed) `create()` key lands
 *  in — the "personalization" pool the spec's mapping table names. A
 *  caller may still target `procedural:` or `semantic:<collection>/<id>`
 *  explicitly via a prefixed key. */
const DEFAULT_SEMANTIC_COLLECTION = 'librechat_personalization';

/**
 * `true` iff an item at this layer/tier must never be written through the
 * console. Episodic + conversational: always (they ARE the audit trail).
 * Any tier === 'corpus' item: always, regardless of layer — the shared
 * corpus is curator/operator-write only (ADR-062 §4), never console-write.
 *
 * @param {{layer: string, tier?: string}} params
 * @returns {boolean}
 */
function isReadOnly({ layer, tier }) {
  if (layer === 'episodic' || layer === 'conversational') {
    return true;
  }
  return tier === 'corpus';
}

/** @param {string} layer @param {string} nativeRef @returns {string} */
function buildCompositeKey(layer, nativeRef) {
  return `${layer}:${nativeRef}`;
}

/**
 * Splits a composite key on its FIRST `:` — native_ref (the semantic
 * variant especially) may itself contain further `:` or `/` characters,
 * so only the layer prefix is ever parsed positionally.
 *
 * @param {string} compositeKey
 * @returns {{layer: string, nativeRef: string} | null} `null` if the
 *   prefix is missing or is not one of the four known layers.
 */
function parseCompositeKey(compositeKey) {
  if (typeof compositeKey !== 'string') {
    return null;
  }
  const separatorIndex = compositeKey.indexOf(':');
  if (separatorIndex <= 0) {
    return null;
  }
  const layer = compositeKey.slice(0, separatorIndex);
  const nativeRef = compositeKey.slice(separatorIndex + 1);
  if (!LAYERS.includes(layer) || nativeRef.length === 0) {
    return null;
  }
  return { layer, nativeRef };
}

/**
 * Splits a semantic native_ref (`{collection}/{document_id}`) on its
 * FIRST `/` — mirrors `_semantic_key` server-side.
 *
 * @param {string} nativeRef
 * @returns {{collection: string, documentId: string} | null}
 */
function parseSemanticNativeRef(nativeRef) {
  if (typeof nativeRef !== 'string') {
    return null;
  }
  const separatorIndex = nativeRef.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex === nativeRef.length - 1) {
    return null;
  }
  return {
    collection: nativeRef.slice(0, separatorIndex),
    documentId: nativeRef.slice(separatorIndex + 1),
  };
}

/**
 * Resolves the write target for a `create()` call from the RAW key
 * LibreChat's POST body supplies. An explicit `procedural:` or
 * `semantic:collection/id` prefix is honoured; anything else (the common
 * case — a plain slug like `"timezone"`) defaults to the personalization
 * semantic collection, per the spec's mapping table ("create default
 * target = semantic").
 *
 * @param {string} rawKey
 * @returns {{layer: 'semantic', collection: string, documentId: string}
 *         | {layer: 'procedural', filename: string}}
 */
function resolveCreateTarget(rawKey) {
  const parsed = parseCompositeKey(rawKey);
  if (parsed != null && parsed.layer === 'procedural') {
    return { layer: 'procedural', filename: parsed.nativeRef };
  }
  if (parsed != null && parsed.layer === 'semantic') {
    const semanticRef = parseSemanticNativeRef(parsed.nativeRef);
    if (semanticRef != null) {
      return { layer: 'semantic', ...semanticRef };
    }
    // `semantic:<id>` with no `/collection` prefix — treat the remainder
    // as the document id in the default collection rather than 400ing on
    // an otherwise-reasonable request.
    return {
      layer: 'semantic',
      collection: DEFAULT_SEMANTIC_COLLECTION,
      documentId: parsed.nativeRef,
    };
  }
  // No recognised prefix (including episodic:/conversational: — those are
  // read-only layers, never a valid CREATE target, so they fall through
  // to the same default rather than being honoured) — the default target.
  return {
    layer: 'semantic',
    collection: DEFAULT_SEMANTIC_COLLECTION,
    documentId: rawKey,
  };
}

module.exports = {
  LAYERS,
  WRITABLE_LAYERS,
  DEFAULT_SEMANTIC_COLLECTION,
  isReadOnly,
  buildCompositeKey,
  parseCompositeKey,
  parseSemanticNativeRef,
  resolveCreateTarget,
};
