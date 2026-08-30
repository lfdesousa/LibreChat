/**
 * The sovereign-memory adapter (M3-WU-D2-2) — the same seven operations
 * `packages/data-schemas/src/methods/memory.ts::createMemoryMethods`
 * exposes to `api/server/routes/memories.js`, but backed by HTTP calls to
 * the BFF `/memory/*` proxy (M3-WU-D2-1) instead of Mongo, gated behind
 * `AUDITTRACE_MEMORY_BACKEND=sovereign` (`config.js`).
 *
 * **Token threading is explicit, not ambient.** Every function here takes
 * a `token` argument — the route handler reads
 * `req.session.openidTokens.accessToken` and passes it straight through
 * (see `memories.js`'s sovereign-guarded blocks). There is no
 * AsyncLocalStorage, no module-level "current user" — this was an
 * explicit, non-blocking design choice in the ratified spec (testable, no
 * magic, `memories.js` is small enough to thread it).
 *
 * **List already includes the shared corpus.** `GET /memory/episodic`,
 * `/procedural`, `/semantic` all merge the caller's private tier with the
 * shared corpus tier server-side (verified 2026-08-30,
 * `src/audittrace/routes/memory.py::list_episodic` lines 1575-1582 and
 * `list_semantic` lines 2300-2311 in AuditTrace-AI) — so "list = union of
 * the four per-layer lists ∪ the shared corpus" from the spec reduces to
 * calling all four per-layer GETs and unioning THEIR results; there is no
 * separate corpus HTTP call. This module adds NO cross-user query, no
 * `$or`, no global escape of its own — isolation is entirely the
 * orchestrator's job (RLS / ADR-062 manifest scoping); this module only
 * forwards the caller's own token.
 *
 * **Read-only enforcement is server-side HERE, not in the UI.** Episodic
 * and conversational are always read-only; any corpus-tier item (in any
 * layer) is read-only too, because the shared corpus is curator/operator
 * write-only — protects the audit trail from a crafted console request.
 * See `keyMapping.js::isReadOnly`.
 */

const { Tokenizer } = require('@librechat/api');

const { callMemoryProxy } = require('./client');
const {
  buildCompositeKey,
  parseCompositeKey,
  parseSemanticNativeRef,
  resolveCreateTarget,
  isReadOnly,
} = require('./keyMapping');
const { ReadOnlyLayerError, InvalidCompositeKeyError } = require('./errors');

const READABLE_LAYER_PATHS = Object.freeze([
  'episodic',
  'procedural',
  'semantic',
  'conversational',
]);

/** @param {string|null|undefined} value @returns {number} */
function tokenCountOf(value) {
  return Tokenizer.getTokenCount(value || '', 'o200k_base');
}

/** @param {number|null|undefined} ms @returns {string} */
function isoFromMs(ms) {
  return new Date(typeof ms === 'number' ? ms : Date.now()).toISOString();
}

/**
 * Maps one manifest-row item from `GET /memory/{episodic,procedural,
 * semantic}` into a LibreChat-shaped entry.
 *
 * @param {'episodic'|'procedural'|'semantic'} layer
 * @param {Record<string, unknown>} item
 * @param {string} userId
 * @returns {Record<string, unknown>}
 */
function mapLayerItem(layer, item, userId) {
  const nativeRef = String(item.key);
  const compositeKey = buildCompositeKey(layer, nativeRef);
  const value = String(item.title || item.key || '');
  const tier = typeof item.tier === 'string' ? item.tier : 'private';
  return {
    _id: compositeKey,
    userId,
    key: compositeKey,
    value,
    tokenCount: tokenCountOf(value),
    updated_at: isoFromMs(item.modified_at_ms ?? item.created_at_ms),
    layer,
    readOnly: isReadOnly({ layer, tier }),
  };
}

/**
 * Maps one row from `GET /memory/conversational` into a LibreChat-shaped
 * entry — always read-only (the session history is the audit trail).
 *
 * @param {Record<string, unknown>} row
 * @param {string} userId
 */
function mapConversationalItem(row, userId) {
  const nativeRef = String(row.id);
  const compositeKey = buildCompositeKey('conversational', nativeRef);
  const value = String(row.summary || '');
  return {
    _id: compositeKey,
    userId,
    key: compositeKey,
    value,
    tokenCount: tokenCountOf(value),
    updated_at: isoFromMs(typeof row.date === 'string' ? Date.parse(row.date) : null),
    layer: 'conversational',
    readOnly: true,
  };
}

/**
 * Lists the caller's memories across all four layers (each per-layer GET
 * already unions private ∪ corpus server-side — see the module
 * docstring). Never partial: if one layer's GET fails, the whole call
 * fails (no silent partial list masquerading as complete).
 *
 * @param {{userId: string, token: string}} params
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function getAllUserMemories({ userId, token }) {
  const [episodic, procedural, semantic, conversational] = await Promise.all([
    callMemoryProxy({ method: 'GET', path: 'episodic', token }),
    callMemoryProxy({ method: 'GET', path: 'procedural', token }),
    callMemoryProxy({ method: 'GET', path: 'semantic', token }),
    callMemoryProxy({ method: 'GET', path: 'conversational', token }),
  ]);

  return [
    ...(episodic.items || []).map((item) => mapLayerItem('episodic', item, userId)),
    ...(procedural.items || []).map((item) => mapLayerItem('procedural', item, userId)),
    ...(semantic.items || []).map((item) => mapLayerItem('semantic', item, userId)),
    ...(conversational.items || []).map((row) => mapConversationalItem(row, userId)),
  ];
}

/**
 * Agent-partitioned memories are deferred (v1 simplification, per the
 * spec's mapping table) — the sovereign store has no partition concept,
 * so this is the same shared-personal-pool list as `getAllUserMemories`,
 * with `agentId` accepted-but-ignored for interface parity with the
 * Mongo method.
 *
 * @param {{userId: string, agentId?: string, token: string}} params
 */
async function getUserMemories({ userId, token }) {
  return getAllUserMemories({ userId, token });
}

/**
 * Fetches the manifest tier for an existing composite-key target so a
 * write to an existing CORPUS-tier item can be rejected even though its
 * layer (semantic/procedural) is nominally writable. Returns `'private'`
 * (the safe assumption for a brand-new key that has never been written)
 * when the item does not exist yet — a 404 here is not a security
 * decision, it just means "nothing to protect yet".
 *
 * @param {{layer: 'semantic'|'procedural', nativeRef: string, token: string}} params
 * @returns {Promise<string>}
 */
async function fetchExistingTier({ layer, nativeRef, token }) {
  const path =
    layer === 'semantic'
      ? (() => {
          const ref = parseSemanticNativeRef(nativeRef);
          if (ref == null) {
            return null;
          }
          return `semantic/${ref.collection}/${ref.documentId}`;
        })()
      : `procedural/${nativeRef}`;
  if (path == null) {
    return 'private';
  }
  try {
    const doc = await callMemoryProxy({ method: 'GET', path, token });
    const metadata = doc && doc.metadata;
    return (metadata && metadata.tier) || 'private';
  } catch (error) {
    if (error && error.status === 404) {
      return 'private';
    }
    throw error;
  }
}

/**
 * Raises {@link ReadOnlyLayerError} for a write aimed at episodic /
 * conversational (always) or at an existing corpus-tier item (fetched
 * on-demand — the composite key alone does not carry tier). NEVER
 * forwards the write to the BFF when this raises.
 *
 * @param {{layer: string, nativeRef: string, token: string, checkExistingTier: boolean}} params
 */
async function assertWritable({ layer, nativeRef, token, checkExistingTier }) {
  if (isReadOnly({ layer, tier: 'private' })) {
    throw new ReadOnlyLayerError(
      `layer '${layer}' is read-only in the sovereign console (audit trail).`,
    );
  }
  if (!checkExistingTier) {
    return;
  }
  const existingTier = await fetchExistingTier({ layer, nativeRef, token });
  if (isReadOnly({ layer, tier: existingTier })) {
    throw new ReadOnlyLayerError(
      `'${layer}:${nativeRef}' is corpus-tier — read-only in the sovereign console.`,
    );
  }
}

/**
 * Creates a memory. Default target is the personalization semantic
 * collection; an explicit `procedural:` or `semantic:collection/id`
 * prefix on `key` picks a different writable target. A read-only prefix
 * (`episodic:`/`conversational:`) is NOT honoured as a create target —
 * `resolveCreateTarget` falls back to the semantic default instead of
 * ever routing a create at a read-only layer.
 *
 * **Read-only enforcement — the SAME `assertWritable` guard `setMemory`/
 * `deleteMemory` use, run BEFORE the POST** (2026-08-30 review fix: a
 * create over an EXISTING read-only/corpus key used to be forwarded
 * unguarded, since `resolveCreateTarget` only ever resolves to a
 * nominally-writable layer — it has no way to know the TARGET key
 * already exists as a corpus-tier item until asked). This is
 * defense-in-depth / fail-fast UX, not the primary control: the
 * orchestrator's own `/memory` write-authorization choke (the certified
 * pre-write check ahead of `_write_layer_private`/`ChromaSemanticService
 * .upsert` in AuditTrace-AI) is what actually MUST hold under a client
 * that skips this guard entirely — belt (here) AND suspenders (there). A
 * server-side 403 that reaches this function anyway (e.g. a TOCTOU race
 * between the guard's GET and this POST) is NEVER swallowed: it is the
 * SAME `SovereignMemoryError` `callMemoryProxy` always throws on a
 * non-2xx status, which `memories.js::respondSovereignError` relays as
 * the identical status — there is no separate "create" error path that
 * could reinterpret it into a 500 or a false 409.
 *
 * Sovereign writes are idempotent/upsert by design (ADR-062) — unlike
 * Mongo's strict-create, re-creating the same (writable, private-tier)
 * key overwrites rather than 409ing; this is a deliberate, documented
 * simplification (the underlying `/memory/{procedural,semantic}` POST
 * endpoints are already upsert-shaped and re-implementing
 * duplicate-detection on top would fight, not follow, that contract).
 *
 * @param {{userId: string, key: string, value: string, tokenCount?: number, agentId?: string, token: string}} params
 * @returns {Promise<{ok: boolean, memory?: Record<string, unknown>}>}
 */
async function createMemory({ userId, key, value, token }) {
  const target = resolveCreateTarget(key);
  if (target.layer === 'procedural') {
    await assertWritable({
      layer: 'procedural',
      nativeRef: target.filename,
      token,
      checkExistingTier: true,
    });
    await callMemoryProxy({
      method: 'POST',
      path: 'procedural',
      token,
      body: { filename: target.filename, content: value },
    });
    return {
      ok: true,
      memory: mapLayerItem('procedural', { key: target.filename, title: target.filename }, userId),
    };
  }
  const semanticNativeRef = `${target.collection}/${target.documentId}`;
  await assertWritable({
    layer: 'semantic',
    nativeRef: semanticNativeRef,
    token,
    checkExistingTier: true,
  });
  await callMemoryProxy({
    method: 'POST',
    path: 'semantic',
    token,
    body: { collection: target.collection, document_id: target.documentId, text: value },
  });
  return {
    ok: true,
    memory: mapLayerItem('semantic', { key: semanticNativeRef, title: target.documentId }, userId),
  };
}

/**
 * Updates (or creates, per the underlying PUT's own upsert-on-write
 * semantics) the item at a composite key. Routes by the key's layer;
 * read-only layer/tier ⇒ {@link ReadOnlyLayerError}, never forwarded.
 *
 * @param {{userId: string, key: string, value: string, token: string}} params
 * @returns {Promise<{ok: boolean, memory?: Record<string, unknown>}>}
 */
async function setMemory({ userId, key, value, token }) {
  const parsed = parseCompositeKey(key);
  if (parsed == null) {
    throw new InvalidCompositeKeyError(`'${key}' is not a valid sovereign-memory key.`);
  }
  const { layer, nativeRef } = parsed;
  await assertWritable({ layer, nativeRef, token, checkExistingTier: true });

  if (layer === 'procedural') {
    await callMemoryProxy({
      method: 'PUT',
      path: `procedural/${nativeRef}`,
      token,
      body: { content: value },
    });
    return {
      ok: true,
      memory: mapLayerItem('procedural', { key: nativeRef, title: nativeRef }, userId),
    };
  }

  const ref = parseSemanticNativeRef(nativeRef);
  if (ref == null) {
    throw new InvalidCompositeKeyError(`'${key}' is not a valid semantic sovereign-memory key.`);
  }
  await callMemoryProxy({
    method: 'PUT',
    path: `semantic/${ref.collection}/${ref.documentId}`,
    token,
    body: { text: value },
  });
  return {
    ok: true,
    memory: mapLayerItem('semantic', { key: nativeRef, title: ref.documentId }, userId),
  };
}

/**
 * Deletes the item at a composite key — always the SOFT (default) path,
 * never `?hard=true` (the reconstructible-by-default behaviour the spec
 * calls out). Read-only layer/tier ⇒ 403, never forwarded.
 *
 * @param {{userId: string, key: string, token: string}} params
 * @returns {Promise<{ok: boolean}>}
 */
async function deleteMemory({ key, token }) {
  const parsed = parseCompositeKey(key);
  if (parsed == null) {
    throw new InvalidCompositeKeyError(`'${key}' is not a valid sovereign-memory key.`);
  }
  const { layer, nativeRef } = parsed;
  await assertWritable({ layer, nativeRef, token, checkExistingTier: true });

  if (layer === 'procedural') {
    await callMemoryProxy({ method: 'DELETE', path: `procedural/${nativeRef}`, token });
    return { ok: true };
  }
  const ref = parseSemanticNativeRef(nativeRef);
  if (ref == null) {
    throw new InvalidCompositeKeyError(`'${key}' is not a valid semantic sovereign-memory key.`);
  }
  await callMemoryProxy({
    method: 'DELETE',
    path: `semantic/${ref.collection}/${ref.documentId}`,
    token,
  });
  return { ok: true };
}

/**
 * `PATCH /memories/id/:id` support. Our `_id` IS the composite key (see
 * `mapLayerItem`/`mapConversationalItem`) — there is no separate opaque
 * row id to resolve, so this is `setMemory` keyed by `id`, with an
 * explicit `key` (if given) selecting a DIFFERENT target instead of a
 * true in-place rename (the sovereign store is content-addressed by
 * layer + native ref, not by a mutable row id — a documented
 * simplification vs. Mongo's ObjectId-keyed rename).
 *
 * @param {{userId: string, id: string, key?: string, value: string, token: string}} params
 */
async function setMemoryById({ userId, id, key, value, token }) {
  const target = key || id;
  return setMemory({ userId, key: target, value, token });
}

/**
 * `DELETE /memories/id/:id` support — `id` IS the composite key.
 *
 * @param {{userId: string, id: string, token: string}} params
 */
async function deleteMemoryById({ userId, id, token }) {
  return deleteMemory({ userId, key: id, token });
}

module.exports = {
  getAllUserMemories,
  getUserMemories,
  createMemory,
  setMemory,
  deleteMemory,
  setMemoryById,
  deleteMemoryById,
  // Exported for the route layer's own logging / diagnostics, not part of
  // the MemoryMethods-shaped surface.
  _internal: { READABLE_LAYER_PATHS, mapLayerItem, mapConversationalItem },
};
