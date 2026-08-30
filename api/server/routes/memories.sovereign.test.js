/**
 * Route-level dispatch tests for M3-WU-D2-2 — `AUDITTRACE_MEMORY_BACKEND`
 * flip between the legacy Mongo path and the sovereign adapter.
 *
 * `memories.test.js` (the pre-existing suite, untouched in behaviour) is
 * the byte-unchanged-mongo-default proof; THIS file is the flag-routing
 * proof in both directions:
 *   - flag unset/`mongo` (default) → the sovereign adapter is NEVER called.
 *   - flag `sovereign`             → the Mongo methods are NEVER called.
 * Neutering either `isSovereignBackend()` guard collapses one of these
 * two directions to the wrong backend, which these assertions catch (RED).
 */

const express = require('express');
const request = require('supertest');

const mockSovereignGetAllUserMemories = jest.fn();
const mockSovereignCreateMemory = jest.fn();
const mockSovereignSetMemory = jest.fn();
const mockSovereignDeleteMemory = jest.fn();

const mockMongoGetAllUserMemories = jest.fn();
const mockMongoCreateMemory = jest.fn();
const mockMongoDeleteMemory = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

jest.mock('@librechat/api', () => ({
  Tokenizer: { getTokenCount: jest.fn(() => 1) },
  generateCheckAccess: jest.fn(() => (_req, _res, next) => next()),
  blockFilteredMemoryContent: jest.fn(() => false),
  projectStoredMemories: jest.fn((memories) => memories),
  createMemoryManagementHandlers: jest.fn(() => ({
    updateById: jest.fn((_req, res) => res.status(202).json({ delegated: 'mongo-update' })),
    deleteById: jest.fn((_req, res) => res.status(202).json({ delegated: 'mongo-delete' })),
  })),
}));

jest.mock('librechat-data-provider', () => ({
  PermissionTypes: { MEMORIES: 'MEMORIES' },
  Permissions: { USE: 'USE', READ: 'READ', CREATE: 'CREATE', UPDATE: 'UPDATE', OPT_OUT: 'OPT_OUT' },
  ResourceType: { AGENT: 'agent' },
  PermissionBits: { VIEW: 1 },
}));

jest.mock('~/server/services/PermissionService', () => ({
  findAccessibleResources: jest.fn().mockResolvedValue([]),
}));

jest.mock('~/models', () => ({
  getAllUserMemories: (...args) => mockMongoGetAllUserMemories(...args),
  getUserMemories: jest.fn().mockResolvedValue([]),
  toggleUserMemories: jest.fn(),
  getRoleByName: jest.fn(),
  createMemory: (...args) => mockMongoCreateMemory(...args),
  deleteMemory: (...args) => mockMongoDeleteMemory(...args),
  setMemory: jest.fn(),
  setMemoryById: jest.fn(),
  deleteMemoryById: jest.fn(),
  getAgents: jest.fn(),
}));

jest.mock('~/server/services/AuditTraceMemory', () => ({
  getAllUserMemories: (...args) => mockSovereignGetAllUserMemories(...args),
  getUserMemories: jest.fn(),
  createMemory: (...args) => mockSovereignCreateMemory(...args),
  setMemory: (...args) => mockSovereignSetMemory(...args),
  deleteMemory: (...args) => mockSovereignDeleteMemory(...args),
  setMemoryById: jest.fn(),
  deleteMemoryById: jest.fn(),
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => {
    req.user = { id: 'user-1', role: 'USER' };
    next();
  },
  configMiddleware: (req, _res, next) => {
    req.config = { filters: undefined, memory: { tokenLimit: null, charLimit: 10000 } };
    next();
  },
}));

const {
  MissingAccessTokenError,
  ReadOnlyLayerError,
} = require('~/server/services/AuditTraceMemory/errors');

const memoriesRouter = require('./memories');

const buildApp = ({ accessToken = 'session-access-token' } = {}) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = accessToken ? { openidTokens: { accessToken } } : {};
    next();
  });
  app.use('/api/memories', memoriesRouter);
  return app;
};

describe('memories.js — AUDITTRACE_MEMORY_BACKEND flag dispatch (M3-WU-D2-2)', () => {
  const ORIGINAL_FLAG = process.env.AUDITTRACE_MEMORY_BACKEND;

  afterEach(() => {
    jest.clearAllMocks();
    if (ORIGINAL_FLAG === undefined) {
      delete process.env.AUDITTRACE_MEMORY_BACKEND;
    } else {
      process.env.AUDITTRACE_MEMORY_BACKEND = ORIGINAL_FLAG;
    }
  });

  describe('flag unset (default) — Mongo path runs, the sovereign adapter is never touched', () => {
    beforeEach(() => {
      delete process.env.AUDITTRACE_MEMORY_BACKEND;
    });

    it('GET / calls the Mongo methods only', async () => {
      mockMongoGetAllUserMemories.mockResolvedValue([]);
      const response = await request(buildApp()).get('/api/memories');
      expect(response.status).toBe(200);
      expect(mockMongoGetAllUserMemories).toHaveBeenCalledWith('user-1');
      expect(mockSovereignGetAllUserMemories).not.toHaveBeenCalled();
    });

    it('DELETE /:key calls the Mongo methods only', async () => {
      mockMongoDeleteMemory.mockResolvedValue({ ok: true });
      const response = await request(buildApp()).delete('/api/memories/some_key');
      expect(response.status).toBe(200);
      expect(mockMongoDeleteMemory).toHaveBeenCalled();
      expect(mockSovereignDeleteMemory).not.toHaveBeenCalled();
    });
  });

  describe('flag = "sovereign" — the adapter runs, Mongo is never touched', () => {
    beforeEach(() => {
      process.env.AUDITTRACE_MEMORY_BACKEND = 'sovereign';
    });

    it('GET / calls the adapter with the session access token, never Mongo', async () => {
      mockSovereignGetAllUserMemories.mockResolvedValue([
        {
          _id: 'semantic:librechat_personalization/timezone',
          userId: 'user-1',
          key: 'semantic:librechat_personalization/timezone',
          value: 'UTC',
          tokenCount: 1,
          updated_at: '2026-08-30T00:00:00.000Z',
          layer: 'semantic',
          readOnly: false,
        },
      ]);

      const response = await request(buildApp({ accessToken: 'session-token-xyz' })).get(
        '/api/memories',
      );

      expect(response.status).toBe(200);
      expect(mockSovereignGetAllUserMemories).toHaveBeenCalledWith({
        userId: 'user-1',
        token: 'session-token-xyz',
      });
      expect(mockMongoGetAllUserMemories).not.toHaveBeenCalled();
      expect(response.body.memories[0]).toMatchObject({ layer: 'semantic', readOnly: false });
    });

    it('GET / returns 401 with NO Mongo fallback when the session has no access token', async () => {
      mockSovereignGetAllUserMemories.mockRejectedValue(new MissingAccessTokenError());

      const response = await request(buildApp({ accessToken: null })).get('/api/memories');

      expect(response.status).toBe(401);
      expect(mockMongoGetAllUserMemories).not.toHaveBeenCalled();
    });

    it("POST / routes to the adapter's createMemory and echoes the mapped entry, never touching Mongo", async () => {
      mockSovereignCreateMemory.mockResolvedValue({
        ok: true,
        memory: {
          _id: 'semantic:librechat_personalization/timezone',
          key: 'semantic:librechat_personalization/timezone',
          layer: 'semantic',
          readOnly: false,
          value: 'UTC',
        },
      });

      const response = await request(buildApp())
        .post('/api/memories')
        .send({ key: 'timezone', value: 'UTC' });

      expect(response.status).toBe(201);
      expect(mockSovereignCreateMemory).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'timezone', value: 'UTC', token: 'session-access-token' }),
      );
      expect(mockMongoCreateMemory).not.toHaveBeenCalled();
    });

    it("PATCH /:key on a read-only layer surfaces 403 (the adapter's guard), not a silent 200, and never touches Mongo", async () => {
      mockSovereignSetMemory.mockRejectedValue(
        new ReadOnlyLayerError("layer 'episodic' is read-only in the sovereign console."),
      );

      const response = await request(buildApp())
        .patch('/api/memories/episodic%3AADR-001.md')
        .send({ value: 'tampered content' });

      expect(response.status).toBe(403);
      expect(mockSovereignSetMemory).toHaveBeenCalledTimes(1);
      expect(mockMongoCreateMemory).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /preferences — out of scope of the store swap, ALWAYS Mongo regardless of the flag', () => {
    it('is unaffected by AUDITTRACE_MEMORY_BACKEND=sovereign', async () => {
      process.env.AUDITTRACE_MEMORY_BACKEND = 'sovereign';
      const { toggleUserMemories } = require('~/models');
      toggleUserMemories.mockResolvedValue({ personalization: { memories: false } });

      const response = await request(buildApp())
        .patch('/api/memories/preferences')
        .send({ memories: false });

      expect(response.status).toBe(200);
      expect(toggleUserMemories).toHaveBeenCalledWith('user-1', false);
    });
  });
});
