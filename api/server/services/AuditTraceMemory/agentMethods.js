/**
 * MemoryMethods-shaped bridge from the agent-side memory write/read surface
 * (`@librechat/api`'s `createMemoryProcessor` / `buildInlineMemoryTool`,
 * consumed by `api/server/controllers/agents/client.js` and
 * `api/app/clients/tools/util/handleTools.js`) onto the SAME sovereign
 * adapter D2-2 built for the panel route (M3-WU-D2-3 Part B — closes the
 * Mongo split-brain: the agent's "remember this" mid-chat writes used to
 * call the Mongo model functions directly, bypassing D2-2's route-level
 * swap entirely, so a chat-written memory and a panel-written memory were
 * two different brains).
 *
 * **No new authorization logic.** Every write here goes through the
 * adapter's OWN guards (`assertWritable` / `ReadOnlyLayerError` on
 * episodic, conversational, or an existing corpus-tier item) — this module
 * is purely a plain-key <-> composite-key + per-request-token-binding
 * bridge onto `./index.js`'s already-reviewed surface, matching
 * `memories.js`'s "explicit threading, not ambient" token design.
 *
 * **`setMemory` calls the adapter's `createMemory`, not its `setMemory`.**
 * The agent tools (`set_memory`/`delete_memory`) operate on a PLAIN key —
 * their tool schema says "The key identifier for this memory", no
 * composite-key syntax is ever exposed to the LLM — matching Mongo's own
 * `setMemory`, which is an upsert keyed by that same plain key. The
 * adapter's `setMemory` requires an ALREADY-composite key (the shape the
 * panel's edit dialog supplies, read back from a prior list); the
 * adapter's `createMemory` is the one that resolves a bare key to the
 * personalization semantic collection (`resolveCreateTarget` in
 * `keyMapping.js`) and is documented upsert-safe — so it is the correct
 * target for an agent-tool plain-key write, not `setMemory`.
 *
 * **`deleteMemory` reuses `resolveCreateTarget` to reconstruct the SAME
 * composite target** a `setMemory`/`createMemory` call with the identical
 * plain key would have landed at, then forwards to the adapter's real
 * `deleteMemory`. No new key-resolution logic is introduced;
 * `resolveCreateTarget` never resolves to episodic/conversational (see
 * `keyMapping.js`), so a delete can never even ATTEMPT a read-only layer
 * by construction — the one layer-based rejection risk left is an
 * EXISTING corpus-tier item, which `deleteMemory`'s own
 * `assertWritable({ checkExistingTier: true })` catches identically to
 * every other adapter write path.
 */

const auditTraceMemory = require('./index');
const { resolveCreateTarget, buildCompositeKey } = require('./keyMapping');
const { isSovereignBackend } = require('./config');

/**
 * Resolves a plain (agent-tool-supplied) key to the composite key the
 * adapter's `setMemory`/`deleteMemory` require, via the SAME resolution
 * `createMemory` already applies to a create — so a delete always targets
 * exactly where a set with the same key would have landed.
 *
 * @param {string} rawKey
 * @returns {string}
 */
function resolveWriteCompositeKey(rawKey) {
  const target = resolveCreateTarget(rawKey);
  if (target.layer === 'procedural') {
    return buildCompositeKey('procedural', target.filename);
  }
  return buildCompositeKey('semantic', `${target.collection}/${target.documentId}`);
}

/**
 * Mirrors `packages/data-schemas/src/methods/memory.ts::getFormattedMemories`'s
 * formatting EXACTLY (same date format, same "key"/"value" line shape) so the
 * LLM sees a consistent context regardless of backend — the only difference
 * is which list it is derived from.
 *
 * @param {{key: string, value: string, tokenCount?: number, updated_at: string}[]} memories
 * @returns {{withKeys: string, withoutKeys: string, totalTokens: number, tokenCountsByKey: Map<string, number>}}
 */
function formatMemories(memories) {
  if (!memories || memories.length === 0) {
    return { withKeys: '', withoutKeys: '', totalTokens: 0, tokenCountsByKey: new Map() };
  }
  const sorted = [...memories].sort(
    (a, b) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime(),
  );
  const { totalTokens, tokenCountsByKey } = sorted.reduce(
    (counts, memory) => {
      const tokenCount = memory.tokenCount || 0;
      counts.totalTokens += tokenCount;
      counts.tokenCountsByKey.set(memory.key, tokenCount);
      return counts;
    },
    { totalTokens: 0, tokenCountsByKey: new Map() },
  );
  const formatDate = (date) => date.toISOString().split('T')[0];
  const withKeys = sorted
    .map((memory, index) => {
      const date = formatDate(new Date(memory.updated_at));
      const tokenInfo = memory.tokenCount ? ` [${memory.tokenCount} tokens]` : '';
      return `${index + 1}. [${date}]. ["key": "${memory.key}"]${tokenInfo}. ["value": "${memory.value}"]`;
    })
    .join('\n\n');
  const withoutKeys = sorted
    .map(
      (memory, index) =>
        `${index + 1}. [${formatDate(new Date(memory.updated_at))}]. ${memory.value}`,
    )
    .join('\n\n');
  return { withKeys, withoutKeys, totalTokens, tokenCountsByKey };
}

/**
 * Builds a `MemoryMethods`-shaped (`setMemory`/`deleteMemory`/
 * `getFormattedMemories`/`getUserMemories`) object backed by the sovereign
 * adapter. Every function takes the SAME call-signature the Mongo model
 * functions do (`{userId, key, value, ...}` etc, per
 * `packages/data-schemas/src/methods/memory.ts`) — only `token` is bound
 * at construction, since it is the one thing that cannot travel through
 * that generic call signature (mirrors `memories.js`'s explicit,
 * non-ambient token threading).
 *
 * @param {{token: string|null}} params
 */
function createSovereignAgentMemoryMethods({ token }) {
  return {
    async setMemory({ userId, key, value }) {
      return auditTraceMemory.createMemory({ userId, key, value, token });
    },
    async deleteMemory({ userId, key }) {
      const compositeKey = resolveWriteCompositeKey(key);
      return auditTraceMemory.deleteMemory({ userId, key: compositeKey, token });
    },
    async getUserMemories({ userId }) {
      return auditTraceMemory.getAllUserMemories({ userId, token });
    },
    async getFormattedMemories({ userId }) {
      const memories = await auditTraceMemory.getAllUserMemories({ userId, token });
      return formatMemories(memories);
    },
  };
}

/**
 * Selects the `MemoryMethods` object an agent-side write/read call should
 * use: the sovereign bridge above when `AUDITTRACE_MEMORY_BACKEND=sovereign`
 * is active, or `mongoMethods` COMPLETELY UNCHANGED (same object reference)
 * otherwise — the single seam both real call sites
 * (`api/server/controllers/agents/client.js`'s `#useMemory` and
 * `api/app/clients/tools/util/handleTools.js`'s `SET_MEMORY_TOOL_NAME` /
 * `DELETE_MEMORY_TOOL_NAME` branch) go through, so this is the ONE place
 * that decides Mongo-vs-sovereign for every agent memory write in the
 * codebase (verified by grep — see the M3-WU-D2-3 Part B build record).
 *
 * Kept deliberately small and side-effect-free (no `req` mutation, no
 * caching) so it is directly unit-testable without instantiating either of
 * the two large, hard-to-unit-test call sites — the same "extract the pure
 * seam" pattern `client.memory.spec.js` already uses for this controller.
 *
 * @param {{req: {session?: {openidTokens?: {accessToken?: string}}}, mongoMethods: object}} params
 * @returns {object} `mongoMethods` (same reference) under the default
 *   `mongo` flag; the sovereign bridge otherwise.
 */
function resolveMemoryWriteMethods({ req, mongoMethods }) {
  if (!isSovereignBackend()) {
    return mongoMethods;
  }
  const token = req?.session?.openidTokens?.accessToken || null;
  return createSovereignAgentMemoryMethods({ token });
}

module.exports = {
  createSovereignAgentMemoryMethods,
  resolveMemoryWriteMethods,
  resolveWriteCompositeKey,
  formatMemories,
};
