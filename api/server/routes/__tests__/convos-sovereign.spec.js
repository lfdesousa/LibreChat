/**
 * Route-level dispatch tests for MongoDB-elimination WU-2 —
 * `AUDITTRACE_MEMORY_BACKEND` flip between the legacy Mongo path and the
 * sovereign `AuditTraceConversations` adapter, at every `routes/convos.js`
 * call site wired to `resolveConversationMethods` (`GET /`, `GET /:id`,
 * `POST /update`, `POST /archive`, `POST /pin`, `DELETE /`, `DELETE /all`).
 *
 * The `DELETE /`/`DELETE /all`/`POST /archive`/`POST /pin` coverage was
 * added 2026-09-11 (remediation pass) — the independent reviewer's first
 * round correctly rejected the original WU-2 for leaving these EXACT
 * routes on Mongo while claiming the shim complete (a real Rule-1 gap: a
 * sovereign-only conversation would silently fail to delete/archive/pin).
 *
 * Mirrors `routes/memories.sovereign.test.js`'s idiom: `convos.spec.js` (the
 * pre-existing suite, untouched in behaviour — still green after this WU's
 * edits) is the byte-unchanged-mongo-default proof; THIS file is the
 * flag-routing proof in both directions, exercised through the REAL
 * `resolveConversationMethods`/adapter code (only the adapter's own HTTP
 * boundary, `AuditTraceConversations/client`, is mocked — no real network).
 *
 * NON-VACUOUS neuter (per the ratified spec's acceptance criterion):
 * hardcoding `resolveConversationMethods` to always `return mongoMethods`
 * (dropping the sovereign branch) was verified by hand during the build to
 * turn every "sovereign" assertion below RED while leaving `convos.spec.js`
 * green; restored, re-verified GREEN. See the build record.
 */

const express = require('express');
const request = require('supertest');

const MOCKS = '../__test-utils__/convos-route-mocks';
const { moderateText, messageIpLimiter, messageUserLimiter } = require(MOCKS);

jest.mock('@librechat/agents', () => require(MOCKS).agents());
jest.mock('@librechat/api', () =>
  require(MOCKS).api({
    createContentFilter: jest.fn(() => (_req, _res, next) => next()),
    extractStoredMessageContent: jest.fn((input) => [input]),
    inspectContent: jest.fn(() => null),
    extractConversationTitleContent: jest.fn(() => []),
    contentFilterBlockResponse: jest.fn(),
    isContentFilterError: jest.fn(() => false),
  }),
);
jest.mock('@librechat/data-schemas', () => require(MOCKS).dataSchemas());
jest.mock('librechat-data-provider', () => require(MOCKS).dataProvider());
jest.mock('~/models', () => require(MOCKS).sharedModels());
jest.mock('~/server/middleware/requireJwtAuth', () => require(MOCKS).requireJwtAuth());
jest.mock('~/server/middleware', () => require(MOCKS).middlewarePassthrough());
jest.mock('~/server/utils/import/fork', () => require(MOCKS).forkUtils());
jest.mock('~/server/utils/import', () => require(MOCKS).importUtils());
jest.mock('~/cache/getLogStores', () => require(MOCKS).logStores());
jest.mock('~/server/routes/files/multer', () => require(MOCKS).multerSetup());
jest.mock('multer', () => require(MOCKS).multerLib());
jest.mock('~/server/services/Endpoints/azureAssistants', () => require(MOCKS).assistantEndpoint());
jest.mock('~/server/services/Endpoints/assistants', () => require(MOCKS).assistantEndpoint());
jest.mock('~/server/services/Endpoints/agents/subagentThreadStore', () =>
  require(MOCKS).subagentThreadStore(),
);
jest.mock('~/server/services/AuditTraceConversations/client', () => ({
  callConsoleConversationsProxy: jest.fn(),
}));

// Silence unused-lint on values only needed for import side effects in some environments.
void moderateText;
void messageIpLimiter;
void messageUserLimiter;

const { SovereignMemoryError } = require('~/server/services/AuditTraceMemory/errors');

const NOT_FOUND = () => Promise.reject(new SovereignMemoryError('not found', 404));

describe('Convos Routes — sovereign backend dispatch (MongoDB-elimination WU-2)', () => {
  let app;
  const {
    getConvosByCursor,
    getConvo,
    saveConvo,
    setConvoPinned,
    deleteConvos,
  } = require('~/models');
  const {
    callConsoleConversationsProxy,
  } = require('~/server/services/AuditTraceConversations/client');

  const ORIGINAL_BACKEND = process.env.AUDITTRACE_MEMORY_BACKEND;

  beforeAll(() => {
    const convosRouter = require('../convos');
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: 'test-user-123', role: 'USER' };
      req.config = {};
      next();
    });
    app.use('/api/convos', convosRouter);
  });

  afterEach(() => {
    jest.clearAllMocks();
    if (ORIGINAL_BACKEND === undefined) {
      delete process.env.AUDITTRACE_MEMORY_BACKEND;
    } else {
      process.env.AUDITTRACE_MEMORY_BACKEND = ORIGINAL_BACKEND;
    }
  });

  describe('default (mongo) flag', () => {
    beforeEach(() => {
      delete process.env.AUDITTRACE_MEMORY_BACKEND;
    });

    it('GET / calls the Mongo model, never the sovereign HTTP boundary', async () => {
      getConvosByCursor.mockResolvedValueOnce({ conversations: [], nextCursor: null });
      await request(app).get('/api/convos').expect(200);
      expect(getConvosByCursor).toHaveBeenCalledWith('test-user-123', expect.any(Object));
      expect(callConsoleConversationsProxy).not.toHaveBeenCalled();
    });

    it('GET /:conversationId calls the Mongo model, never the sovereign HTTP boundary', async () => {
      getConvo.mockResolvedValueOnce({ conversationId: 'c1' });
      await request(app).get('/api/convos/c1').expect(200);
      expect(getConvo).toHaveBeenCalledWith('test-user-123', 'c1');
      expect(callConsoleConversationsProxy).not.toHaveBeenCalled();
    });

    it('POST /pin calls the Mongo model, never the sovereign HTTP boundary', async () => {
      setConvoPinned.mockResolvedValueOnce({ conversationId: 'c1', pinned: true });
      await request(app)
        .post('/api/convos/pin')
        .send({ arg: { conversationId: 'c1', pinned: true } })
        .expect(200);
      expect(setConvoPinned).toHaveBeenCalledWith('test-user-123', 'c1', true);
      expect(callConsoleConversationsProxy).not.toHaveBeenCalled();
    });

    it('DELETE / calls the Mongo model, never the sovereign HTTP boundary', async () => {
      deleteConvos.mockResolvedValueOnce({ conversationIds: ['c1'], deletedCount: 1 });
      await request(app)
        .delete('/api/convos')
        .send({ arg: { conversationId: 'c1' } })
        .expect(201);
      expect(deleteConvos).toHaveBeenCalled();
      expect(callConsoleConversationsProxy).not.toHaveBeenCalled();
    });
  });

  describe('sovereign flag', () => {
    beforeEach(() => {
      process.env.AUDITTRACE_MEMORY_BACKEND = 'sovereign';
    });

    it('GET / routes to the sovereign adapter and NEVER calls the Mongo model', async () => {
      callConsoleConversationsProxy.mockResolvedValueOnce({ items: [], next_cursor: null });
      await request(app).get('/api/convos').expect(200);
      expect(callConsoleConversationsProxy).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'GET', path: '' }),
      );
      expect(getConvosByCursor).not.toHaveBeenCalled();
    });

    it('GET /:conversationId routes to the sovereign adapter and NEVER calls the Mongo model', async () => {
      callConsoleConversationsProxy.mockResolvedValueOnce({
        conversation_id: 'c1',
        title: 't',
        is_temporary: false,
        created_at_ms: 0,
        updated_at_ms: 0,
        metadata: {},
      });
      const res = await request(app).get('/api/convos/c1').expect(200);
      expect(res.body.conversationId).toBe('c1');
      expect(callConsoleConversationsProxy).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'GET', path: 'c1' }),
      );
      expect(getConvo).not.toHaveBeenCalled();
    });

    it('POST /update routes the title write to the sovereign adapter and NEVER calls the Mongo model', async () => {
      callConsoleConversationsProxy.mockImplementationOnce(NOT_FOUND).mockResolvedValueOnce({
        conversation_id: 'c1',
        title: 'New title',
        is_temporary: false,
        created_at_ms: 0,
        updated_at_ms: 0,
        metadata: {},
      });
      await request(app)
        .post('/api/convos/update')
        .send({ arg: { conversationId: 'c1', title: 'New title' } })
        .expect(201);
      expect(callConsoleConversationsProxy).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          path: '',
          body: expect.objectContaining({ conversation_id: 'c1', title: 'New title' }),
        }),
      );
      expect(saveConvo).not.toHaveBeenCalled();
    });

    it('POST /archive routes the archive write to the sovereign adapter and NEVER calls the Mongo model', async () => {
      callConsoleConversationsProxy.mockImplementationOnce(NOT_FOUND).mockResolvedValueOnce({
        conversation_id: 'c1',
        title: 't',
        is_temporary: false,
        created_at_ms: 0,
        updated_at_ms: 0,
        metadata: { isArchived: true },
      });
      const res = await request(app)
        .post('/api/convos/archive')
        .send({ arg: { conversationId: 'c1', isArchived: true } })
        .expect(200);
      expect(res.body.isArchived).toBe(true);
      expect(callConsoleConversationsProxy).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          path: '',
          body: expect.objectContaining({ conversation_id: 'c1', metadata: { isArchived: true } }),
        }),
      );
      expect(saveConvo).not.toHaveBeenCalled();
    });

    it('POST /pin routes the pin write to the sovereign adapter and NEVER calls the Mongo model', async () => {
      callConsoleConversationsProxy.mockImplementationOnce(NOT_FOUND).mockResolvedValueOnce({
        conversation_id: 'c1',
        title: 't',
        is_temporary: false,
        created_at_ms: 0,
        updated_at_ms: 0,
        metadata: { pinned: true },
      });
      const res = await request(app)
        .post('/api/convos/pin')
        .send({ arg: { conversationId: 'c1', pinned: true } })
        .expect(200);
      expect(res.body.pinned).toBe(true);
      expect(callConsoleConversationsProxy).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'POST', path: '' }),
      );
      expect(setConvoPinned).not.toHaveBeenCalled();
    });

    it('DELETE / (single conversationId) routes to the sovereign adapter and NEVER calls the Mongo model', async () => {
      callConsoleConversationsProxy.mockResolvedValueOnce(undefined); // DELETE c1
      await request(app)
        .delete('/api/convos')
        .send({ arg: { conversationId: 'c1' } })
        .expect(201);
      expect(callConsoleConversationsProxy).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'DELETE', path: 'c1' }),
      );
      expect(deleteConvos).not.toHaveBeenCalled();
    });

    it('DELETE /all routes to the sovereign adapter (collect-all pass) and NEVER calls the Mongo model', async () => {
      callConsoleConversationsProxy.mockResolvedValueOnce({ items: [], next_cursor: null });
      await request(app).delete('/api/convos/all').expect(201);
      expect(callConsoleConversationsProxy).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'GET', path: '' }),
      );
      expect(deleteConvos).not.toHaveBeenCalled();
    });

    /**
     * `forkConversation`/`duplicateConversation`/`importConversations` are
     * themselves mocked in this suite (their OWN `conversationDb`-injection
     * plumbing is proved by `utils/import/fork.spec.js` and
     * `importConversations.spec.js`) — these assertions prove ONLY that
     * `routes/convos.js` resolves and threads a genuinely-different
     * (sovereign) `conversationDb` into them, never the raw Mongo functions.
     */
    it('POST /fork resolves a conversationDb distinct from the raw Mongo functions', async () => {
      const { forkConversation } = require('~/server/utils/import/fork');
      const { getConvo, getMessages, bulkSaveConvos, bulkSaveMessages } = require('~/models');
      forkConversation.mockResolvedValue({ conversation: { conversationId: 'c2' } });

      await request(app).post('/api/convos/fork').send({ conversationId: 'c1', messageId: 'm1' });

      const received = forkConversation.mock.calls[0][0].conversationDb;
      expect(received.getConvo).not.toBe(getConvo);
      expect(received.getMessages).not.toBe(getMessages);
      expect(received.bulkSaveConvos).not.toBe(bulkSaveConvos);
      expect(received.bulkSaveMessages).not.toBe(bulkSaveMessages);
    });

    it('POST /duplicate resolves a conversationDb distinct from the raw Mongo functions', async () => {
      const { duplicateConversation } = require('~/server/utils/import/fork');
      const { getConvo, getMessages, bulkSaveConvos, bulkSaveMessages } = require('~/models');
      duplicateConversation.mockResolvedValue({ conversation: { conversationId: 'c2' } });

      await request(app).post('/api/convos/duplicate').send({ conversationId: 'c1' });

      const received = duplicateConversation.mock.calls[0][0].conversationDb;
      expect(received.getConvo).not.toBe(getConvo);
      expect(received.getMessages).not.toBe(getMessages);
      expect(received.bulkSaveConvos).not.toBe(bulkSaveConvos);
      expect(received.bulkSaveMessages).not.toBe(bulkSaveMessages);
    });

    it('POST /import resolves a conversationDb distinct from the raw Mongo functions', async () => {
      const { importConversations } = require('~/server/utils/import');
      const { bulkSaveConvos, bulkSaveMessages } = require('~/models');
      importConversations.mockResolvedValue(undefined);

      await request(app)
        .post('/api/convos/import')
        .attach('file', Buffer.from('{}'), 'export.json');

      const received = importConversations.mock.calls[0][0].conversationDb;
      expect(received.bulkSaveConvos).not.toBe(bulkSaveConvos);
      expect(received.bulkSaveMessages).not.toBe(bulkSaveMessages);
    });
  });
});
