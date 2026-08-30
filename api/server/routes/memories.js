const express = require('express');
const { logger } = require('@librechat/data-schemas');
const {
  Tokenizer,
  generateCheckAccess,
  blockFilteredMemoryContent,
  projectStoredMemories,
  createMemoryManagementHandlers,
} = require('@librechat/api');
const {
  PermissionTypes,
  PermissionBits,
  ResourceType,
  Permissions,
} = require('librechat-data-provider');
const { findAccessibleResources } = require('~/server/services/PermissionService');
const {
  getAllUserMemories,
  getUserMemories,
  toggleUserMemories,
  getRoleByName,
  createMemory,
  deleteMemory,
  setMemory,
  setMemoryById,
  deleteMemoryById,
  getAgents,
} = require('~/models');
const { requireJwtAuth, configMiddleware } = require('~/server/middleware');
// M3-WU-D2-2 — the sovereign-memory adapter + its feature flag. `mongo`
// (default, unset) never even touches this import's exports; every route
// below guards on `isSovereignBackend()` BEFORE any of the Mongo-backed
// code that follows it, so the Mongo path is untouched when the flag is
// at its default.
const auditTraceMemory = require('~/server/services/AuditTraceMemory');
const { isSovereignBackend } = require('~/server/services/AuditTraceMemory/config');
const { SovereignMemoryError } = require('~/server/services/AuditTraceMemory/errors');

const router = express.Router();

const memoryPayloadLimit = express.json({ limit: '100kb' });

const checkMemoryRead = generateCheckAccess({
  permissionType: PermissionTypes.MEMORIES,
  permissions: [Permissions.USE, Permissions.READ],
  getRoleByName,
});
const checkMemoryCreate = generateCheckAccess({
  permissionType: PermissionTypes.MEMORIES,
  permissions: [Permissions.USE, Permissions.CREATE],
  getRoleByName,
});
const checkMemoryUpdate = generateCheckAccess({
  permissionType: PermissionTypes.MEMORIES,
  permissions: [Permissions.USE, Permissions.UPDATE],
  getRoleByName,
});
const checkMemoryDelete = generateCheckAccess({
  permissionType: PermissionTypes.MEMORIES,
  permissions: [Permissions.USE, Permissions.UPDATE],
  getRoleByName,
});
const checkMemoryOptOut = generateCheckAccess({
  permissionType: PermissionTypes.MEMORIES,
  permissions: [Permissions.USE, Permissions.OPT_OUT],
  getRoleByName,
});
const opaqueMemoryHandlers = createMemoryManagementHandlers({
  setMemoryById,
  deleteMemoryById,
  projectStoredMemories,
  countTokens: (value) => Tokenizer.getTokenCount(value, 'o200k_base'),
});

router.use(requireJwtAuth);

/** Normalizes the optional agent partition param; undefined = shared personal pool */
const getAgentIdParam = (value) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

/**
 * The user's own access token, server-side (M3-WU-D2-2). Read from the
 * session LibreChat's own OpenID login flow already populates
 * (`AuthController.js`'s `req.session.openidTokens`) — the fork gains NO
 * Keycloak client and NO token logic of its own; it only forwards this
 * token as `Authorization: Bearer` to the BFF `/memory/*` proxy, which
 * does the RFC 8693 exchange. `null` (never `undefined`) when absent, so
 * every sovereign-backend call below fails closed the same way regardless
 * of which optional-chaining step was the one that came up empty.
 */
const getSovereignAccessToken = (req) => req.session?.openidTokens?.accessToken || null;

/**
 * Maps a `SovereignMemoryError` (missing token → 401, read-only-layer
 * write → 403, an upstream status the BFF relayed byte-faithfully, or a
 * malformed composite key → 400) onto the SAME status; anything else is a
 * genuine adapter/transport bug, logged and surfaced as a generic 500 —
 * never silently swallowed, and NEVER a fall-through to the Mongo path
 * below (every sovereign branch in this file `return`s from its own
 * try/catch, mongo or otherwise).
 */
const respondSovereignError = (res, error) => {
  if (error instanceof SovereignMemoryError) {
    return res.status(error.status).json({ error: error.message });
  }
  logger.error('[memories] sovereign memory backend error', error);
  return res.status(500).json({ error: 'Failed to process sovereign memory request.' });
};

/** Resolves agent display names for agent-partitioned memories, restricted
 *  to agents the requester can VIEW — `agentId` is caller-supplied on write,
 *  so an unrestricted lookup would leak private agents' names. */
const withAgentNames = async (memories, user) => {
  const agentIds = [...new Set(memories.map((m) => m.agentId).filter(Boolean))];
  if (agentIds.length === 0) {
    return memories;
  }
  try {
    const accessibleIds = await findAccessibleResources({
      userId: user.id,
      role: user.role,
      resourceType: ResourceType.AGENT,
      requiredPermissions: PermissionBits.VIEW,
    });
    const agents = await getAgents({ id: { $in: agentIds }, _id: { $in: accessibleIds } });
    const namesById = new Map(agents.map((agent) => [agent.id, agent.name]));
    return memories.map((memory) =>
      memory.agentId
        ? { ...memory, agentName: namesById.get(memory.agentId) ?? undefined }
        : memory,
    );
  } catch (_error) {
    return memories;
  }
};

/**
 * GET /memories
 * Returns all memories for the authenticated user, sorted by updated_at (newest first).
 * Also includes memory usage percentage based on token limit.
 */
router.get('/', checkMemoryRead, configMiddleware, async (req, res) => {
  if (isSovereignBackend()) {
    const token = getSovereignAccessToken(req);
    try {
      const memories = await auditTraceMemory.getAllUserMemories({ userId: req.user.id, token });
      const projectedMemories = projectStoredMemories(memories, req.config?.filters);
      const sortedMemories = projectedMemories.sort(
        (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
      );
      const totalTokens = memories.reduce((sum, memory) => sum + (memory.tokenCount || 0), 0);
      const appConfig = req.config;
      const memoryConfig = appConfig?.memory;
      const tokenLimit = memoryConfig?.tokenLimit;
      const charLimit = memoryConfig?.charLimit || 10000;
      let usagePercentage = null;
      if (tokenLimit && tokenLimit > 0) {
        usagePercentage = Math.min(100, Math.round((totalTokens / tokenLimit) * 100));
      }
      return res.json({
        memories: sortedMemories,
        totalTokens,
        tokenLimit: tokenLimit || null,
        charLimit,
        usagePercentage,
      });
    } catch (error) {
      return respondSovereignError(res, error);
    }
  }

  try {
    const memories = await getAllUserMemories(req.user.id);
    const projectedMemories = projectStoredMemories(memories, req.config?.filters);

    const sortedMemories = (await withAgentNames(projectedMemories, req.user)).sort(
      (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );

    /** Usage totals reflect the shared personal pool only — `tokenLimit`
     *  applies per partition, matching the inline tools' enforcement. */
    const totalTokens = memories.reduce((sum, memory) => {
      return sum + (memory.agentId ? 0 : memory.tokenCount || 0);
    }, 0);

    const appConfig = req.config;
    const memoryConfig = appConfig?.memory;
    const tokenLimit = memoryConfig?.tokenLimit;
    const charLimit = memoryConfig?.charLimit || 10000;

    let usagePercentage = null;
    if (tokenLimit && tokenLimit > 0) {
      usagePercentage = Math.min(100, Math.round((totalTokens / tokenLimit) * 100));
    }

    res.json({
      memories: sortedMemories,
      totalTokens,
      tokenLimit: tokenLimit || null,
      charLimit,
      usagePercentage,
    });
  } catch (_error) {
    res.status(500).json({ error: 'Failed to retrieve memories.' });
  }
});

/**
 * POST /memories
 * Creates a new memory entry for the authenticated user.
 * Body: { key: string, value: string }
 * Returns 201 and { created: true, memory: <createdDoc> } when successful.
 */
router.post('/', memoryPayloadLimit, checkMemoryCreate, configMiddleware, async (req, res) => {
  const { key, value } = req.body;
  const agentId = getAgentIdParam(req.body.agentId);

  if (typeof key !== 'string' || key.trim() === '') {
    return res.status(400).json({ error: 'Key is required and must be a non-empty string.' });
  }

  if (typeof value !== 'string' || value.trim() === '') {
    return res.status(400).json({ error: 'Value is required and must be a non-empty string.' });
  }

  const appConfig = req.config;
  const memoryConfig = appConfig?.memory;
  const charLimit = memoryConfig?.charLimit || 10000;

  if (key.length > 1000) {
    return res.status(400).json({
      error: `Key exceeds maximum length of 1000 characters. Current length: ${key.length} characters.`,
    });
  }

  if (value.length > charLimit) {
    return res.status(400).json({
      error: `Value exceeds maximum length of ${charLimit} characters. Current length: ${value.length} characters.`,
    });
  }

  const normalizedMemory = { key: key.trim(), value: value.trim() };
  if (blockFilteredMemoryContent(req, res, normalizedMemory)) {
    return;
  }

  if (isSovereignBackend()) {
    const token = getSovereignAccessToken(req);
    try {
      const result = await auditTraceMemory.createMemory({
        userId: req.user.id,
        key: key.trim(),
        value: value.trim(),
        token,
      });
      if (!result.ok) {
        return res.status(500).json({ error: 'Failed to create memory.' });
      }
      return res.status(201).json({ created: true, memory: result.memory });
    } catch (error) {
      return respondSovereignError(res, error);
    }
  }

  try {
    const tokenCount = Tokenizer.getTokenCount(value, 'o200k_base');

    const memories = await getUserMemories({ userId: req.user.id, agentId });

    const appConfig = req.config;
    const memoryConfig = appConfig?.memory;
    const tokenLimit = memoryConfig?.tokenLimit;

    if (tokenLimit) {
      const currentTotalTokens = memories.reduce(
        (sum, memory) => sum + (memory.tokenCount || 0),
        0,
      );
      if (currentTotalTokens + tokenCount > tokenLimit) {
        return res.status(400).json({
          error: `Adding this memory would exceed the token limit of ${tokenLimit}. Current usage: ${currentTotalTokens} tokens.`,
        });
      }
    }

    const result = await createMemory({
      userId: req.user.id,
      key: key.trim(),
      value: value.trim(),
      tokenCount,
      agentId,
    });

    if (!result.ok) {
      return res.status(500).json({ error: 'Failed to create memory.' });
    }

    const updatedMemories = await getUserMemories({ userId: req.user.id, agentId });
    const newMemory = updatedMemories.find((m) => m.key === key.trim());

    res.status(201).json({ created: true, memory: newMemory });
  } catch (error) {
    if (error.message && error.message.includes('already exists')) {
      return res.status(409).json({ error: 'Memory with this key already exists.' });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * PATCH /memories/preferences
 * Updates the user's memory preferences (e.g., enabling/disabling memories).
 * Body: { memories: boolean }
 * Returns 200 and { updated: true, preferences: { memories: boolean } } when successful.
 */
router.patch('/preferences', checkMemoryOptOut, async (req, res) => {
  const { memories } = req.body;

  if (typeof memories !== 'boolean') {
    return res.status(400).json({ error: 'memories must be a boolean value.' });
  }

  try {
    const updatedUser = await toggleUserMemories(req.user.id, memories);

    if (!updatedUser) {
      return res.status(404).json({ error: 'User not found.' });
    }

    res.json({
      updated: true,
      preferences: {
        memories: updatedUser.personalization?.memories ?? true,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * `_id` under the sovereign backend IS the composite key
 * (`{layer}:{native_ref}` — see `AuditTraceMemory/index.js::mapLayerItem`),
 * not a Mongo ObjectId, so `/id/:id` routes to `setMemory`/`deleteMemory`
 * keyed by `id` rather than `@librechat/api`'s generic
 * `createMemoryManagementHandlers` (that factory's `deps.setMemoryById`
 * call site has no token parameter to thread through — reusing it would
 * force ambient token access, which the ratified spec explicitly rejected
 * in favour of explicit threading).
 */
async function sovereignUpdateById(req, res) {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  const value = req.body?.value;
  if (typeof value !== 'string' || value.trim() === '') {
    return res.status(400).json({ error: 'Value is required and must be a non-empty string.' });
  }
  const submittedKey = req.body?.key;
  const charLimit = req.config?.memory?.charLimit || 10000;
  if (value.length > charLimit) {
    return res.status(400).json({
      error: `Value exceeds maximum length of ${charLimit} characters. Current length: ${value.length} characters.`,
    });
  }
  if (
    blockFilteredMemoryContent(req, res, { ...(submittedKey ? { key: submittedKey } : {}), value })
  ) {
    return;
  }
  const token = getSovereignAccessToken(req);
  try {
    const result = await auditTraceMemory.setMemoryById({
      userId,
      id: req.params.id,
      key: submittedKey,
      value,
      token,
    });
    if (!result.ok) {
      return res.status(404).json({ error: 'Memory not found.' });
    }
    return res.status(200).json({ updated: true, memory: result.memory });
  } catch (error) {
    return respondSovereignError(res, error);
  }
}

async function sovereignDeleteById(req, res) {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  const token = getSovereignAccessToken(req);
  try {
    const result = await auditTraceMemory.deleteMemoryById({ userId, id: req.params.id, token });
    if (!result.ok) {
      return res.status(404).json({ error: 'Memory not found.' });
    }
    return res.status(200).json({ deleted: true });
  } catch (error) {
    return respondSovereignError(res, error);
  }
}

router.patch('/id/:id', memoryPayloadLimit, checkMemoryUpdate, configMiddleware, (req, res) =>
  isSovereignBackend() ? sovereignUpdateById(req, res) : opaqueMemoryHandlers.updateById(req, res),
);
router.delete('/id/:id', checkMemoryDelete, (req, res) =>
  isSovereignBackend() ? sovereignDeleteById(req, res) : opaqueMemoryHandlers.deleteById(req, res),
);

/**
 * PATCH /memories/:key
 * Updates the value of an existing memory entry for the authenticated user.
 * Body: { key?: string, value: string }
 * Returns 200 and { updated: true, memory: <updatedDoc> } when successful.
 */
router.patch('/:key', memoryPayloadLimit, checkMemoryUpdate, configMiddleware, async (req, res) => {
  const { key: urlKey } = req.params;
  const { key: bodyKey, value } = req.body || {};
  const agentId = getAgentIdParam(req.query.agentId);

  if (typeof value !== 'string' || value.trim() === '') {
    return res.status(400).json({ error: 'Value is required and must be a non-empty string.' });
  }

  const newKey = bodyKey || urlKey;
  const appConfig = req.config;
  const memoryConfig = appConfig?.memory;
  const charLimit = memoryConfig?.charLimit || 10000;

  if (newKey.length > 1000) {
    return res.status(400).json({
      error: `Key exceeds maximum length of 1000 characters. Current length: ${newKey.length} characters.`,
    });
  }

  if (value.length > charLimit) {
    return res.status(400).json({
      error: `Value exceeds maximum length of ${charLimit} characters. Current length: ${value.length} characters.`,
    });
  }

  if (blockFilteredMemoryContent(req, res, { key: newKey, value })) {
    return;
  }

  if (isSovereignBackend()) {
    const token = getSovereignAccessToken(req);
    try {
      if (newKey !== urlKey) {
        const createResult = await auditTraceMemory.setMemory({
          userId: req.user.id,
          key: newKey,
          value,
          token,
        });
        if (!createResult.ok) {
          return res.status(500).json({ error: 'Failed to create new memory.' });
        }
        const deleteResult = await auditTraceMemory.deleteMemory({
          userId: req.user.id,
          key: urlKey,
          token,
        });
        if (!deleteResult.ok) {
          return res.status(500).json({ error: 'Failed to delete old memory.' });
        }
        return res.json({ updated: true, memory: createResult.memory });
      }
      const result = await auditTraceMemory.setMemory({
        userId: req.user.id,
        key: urlKey,
        value,
        token,
      });
      if (!result.ok) {
        return res.status(404).json({ error: 'Memory not found.' });
      }
      return res.json({ updated: true, memory: result.memory });
    } catch (error) {
      return respondSovereignError(res, error);
    }
  }

  try {
    const tokenCount = Tokenizer.getTokenCount(value, 'o200k_base');

    const memories = await getUserMemories({ userId: req.user.id, agentId });
    const existingMemory = memories.find((m) => m.key === urlKey);

    if (!existingMemory) {
      return res.status(404).json({ error: 'Memory not found.' });
    }

    if (newKey !== urlKey) {
      const keyExists = memories.find((m) => m.key === newKey);
      if (keyExists) {
        return res.status(409).json({ error: 'Memory with this key already exists.' });
      }

      const createResult = await createMemory({
        userId: req.user.id,
        key: newKey,
        value,
        tokenCount,
        agentId,
      });

      if (!createResult.ok) {
        return res.status(500).json({ error: 'Failed to create new memory.' });
      }

      const deleteResult = await deleteMemory({ userId: req.user.id, key: urlKey, agentId });
      if (!deleteResult.ok) {
        return res.status(500).json({ error: 'Failed to delete old memory.' });
      }
    } else {
      const result = await setMemory({
        userId: req.user.id,
        key: newKey,
        value,
        tokenCount,
        agentId,
      });

      if (!result.ok) {
        return res.status(500).json({ error: 'Failed to update memory.' });
      }
    }

    const updatedMemories = await getUserMemories({ userId: req.user.id, agentId });
    const updatedMemory = updatedMemories.find((m) => m.key === newKey);

    res.json({ updated: true, memory: updatedMemory });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /memories/:key
 * Deletes a memory entry for the authenticated user.
 * Returns 200 and { deleted: true } when successful.
 */
router.delete('/:key', checkMemoryDelete, async (req, res) => {
  const { key } = req.params;
  const agentId = getAgentIdParam(req.query.agentId);

  if (isSovereignBackend()) {
    const token = getSovereignAccessToken(req);
    try {
      const result = await auditTraceMemory.deleteMemory({ userId: req.user.id, key, token });
      if (!result.ok) {
        return res.status(404).json({ error: 'Memory not found.' });
      }
      return res.json({ deleted: true });
    } catch (error) {
      return respondSovereignError(res, error);
    }
  }

  try {
    const result = await deleteMemory({ userId: req.user.id, key, agentId });

    if (!result.ok) {
      return res.status(404).json({ error: 'Memory not found.' });
    }

    res.json({ deleted: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
