/**
 * Route-level dispatch tests for MongoDB-elimination WU-2 —
 * `AUDITTRACE_MEMORY_BACKEND` flip between the legacy Mongo path and the
 * sovereign `AuditTraceConversations` adapter, at every `routes/messages.js`
 * call site wired to `resolveConversationMethods` (`GET /:conversationId`
 * message-tree read, `POST /:conversationId` save-message-and-convo write,
 * `GET /:conversationId/:messageId` single-message read,
 * `PUT /:conversationId/:messageId` text edit,
 * `DELETE /:conversationId/:messageId` single-message delete).
 *
 * The single-message GET/PUT/DELETE coverage was added 2026-09-11
 * (remediation pass) — the independent reviewer's first round correctly
 * rejected the original WU-2 for leaving these EXACT routes on Mongo while
 * claiming the shim complete (a real Rule-1 gap: a sovereign-only message
 * would silently fail to edit/delete, or 404 as "not found" on a GET that
 * should have succeeded).
 *
 * Mirrors `convos-sovereign.spec.js`'s idiom (see that file's docstring for
 * the shared rationale + non-vacuous-neuter note). Only the adapter's own
 * HTTP boundary (`AuditTraceConversations/client`) is mocked — no real
 * network — so this exercises the REAL `resolveConversationMethods`.
 */

const express = require('express');
const request = require('supertest');

jest.mock('@librechat/agents', () => ({ sleep: jest.fn() }));

jest.mock('@librechat/api', () => ({
  createContentFilter: jest.fn(() => (_req, _res, next) => next()),
  extractStoredMessageContent: jest.fn(() => []),
  extractFeedbackContent: jest.fn(() => []),
  isContentFilterError: jest.fn(() => false),
  unescapeLaTeX: jest.fn((x) => x),
  countTokens: jest.fn().mockResolvedValue(10),
  mergeQuotedTextForCount: jest.fn((text) => text),
  sendFeedbackScore: jest.fn().mockResolvedValue(undefined),
  traceIdForMessage: jest.fn((messageId) => `trace-${messageId}`),
  CHILD_THREAD_READ_ONLY_ERROR: 'Child thread is view-only.',
  isSubagentThreadWriteBlocked: jest.fn().mockResolvedValue(false),
  requireFeedbackEnabled: (_req, _res, next) => next(),
  assertStoredMessageMutationAllowed: jest.fn(),
  assertChatMutationAllowed: jest.fn(),
  assertStoredMessageBranchAllowed: jest.fn(),
  mergeUserSubmittedPaths: (...lists) => [...new Set(lists.flat().filter(Boolean))],
  mergeUserSubmittedMessageFieldPaths: (...lists) => lists.flat().filter(Boolean),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  CLIENT_MESSAGE_SELECT: 'text sender',
}));

jest.mock('librechat-data-provider', () => ({
  ContentTypes: {},
  feedbackSchema: { safeParse: jest.fn() },
  isAssistantsEndpoint: jest.fn(() => false),
  stripReasoningLabelMetadata: jest.fn((x) => x),
}));

jest.mock('~/server/services/Endpoints/agents/subagentThreadStore', () => ({}));
jest.mock('~/server/services/Artifacts/update', () => ({
  findAllArtifacts: jest.fn(),
  replaceArtifactContent: jest.fn(),
}));
jest.mock('~/server/middleware/requireJwtAuth', () => (_req, _res, next) => next());
jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (_req, _res, next) => next(),
  validateMessageReq: (_req, _res, next) => next(),
  configMiddleware: (req, _res, next) => {
    req.config = { filters: {} };
    next();
  },
  sendValidationResponse: jest.fn((res, result) => res.status(result.status).json(result.body)),
  canReadActiveJobConversation: jest.fn().mockResolvedValue(false),
  prepareMessageRequestValidation: (req, _res, next) => {
    req.messageRequestValidation = {
      conversationId: req.params.conversationId,
      shouldFetchMessages: true,
      promise: Promise.resolve({ ok: true }),
    };
    next();
  },
}));
jest.mock('~/models', () => ({
  saveConvo: jest.fn(),
  saveMessage: jest.fn(),
  getMessages: jest.fn(),
  updateMessage: jest.fn(),
  deleteMessages: jest.fn(),
  getMessage: jest.fn(),
  getFiles: jest.fn(),
}));
jest.mock('~/server/services/AuditTraceConversations/client', () => ({
  callConsoleConversationsProxy: jest.fn(),
}));

const { SovereignMemoryError } = require('~/server/services/AuditTraceMemory/errors');

const NOT_FOUND = () => Promise.reject(new SovereignMemoryError('not found', 404));

describe('Messages Routes — sovereign backend dispatch (MongoDB-elimination WU-2)', () => {
  let app;
  const {
    getMessages,
    saveMessage,
    saveConvo,
    updateMessage,
    deleteMessages,
  } = require('~/models');
  const {
    callConsoleConversationsProxy,
  } = require('~/server/services/AuditTraceConversations/client');

  const ORIGINAL_BACKEND = process.env.AUDITTRACE_MEMORY_BACKEND;

  beforeAll(() => {
    const messagesRouter = require('../messages');
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: 'test-user-123' };
      next();
    });
    app.use('/api/messages', messagesRouter);
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

    it('GET /:conversationId calls the Mongo model, never the sovereign HTTP boundary', async () => {
      getMessages.mockResolvedValueOnce([]);
      await request(app).get('/api/messages/c1').expect(200);
      expect(getMessages).toHaveBeenCalledWith(
        { conversationId: 'c1', user: 'test-user-123' },
        'text sender',
      );
      expect(callConsoleConversationsProxy).not.toHaveBeenCalled();
    });

    it('POST /:conversationId calls the Mongo model, never the sovereign HTTP boundary', async () => {
      saveMessage.mockResolvedValueOnce({ conversationId: 'c1', messageId: 'm1' });
      saveConvo.mockResolvedValueOnce({ conversationId: 'c1' });
      await request(app).post('/api/messages/c1').send({ messageId: 'm1', text: 'hi' }).expect(201);
      expect(saveMessage).toHaveBeenCalled();
      expect(saveConvo).toHaveBeenCalled();
      expect(callConsoleConversationsProxy).not.toHaveBeenCalled();
    });

    it('GET /:conversationId/:messageId calls the Mongo model, never the sovereign HTTP boundary', async () => {
      getMessages.mockResolvedValueOnce([{ messageId: 'm1' }]);
      await request(app).get('/api/messages/c1/m1').expect(200);
      expect(getMessages).toHaveBeenCalled();
      expect(callConsoleConversationsProxy).not.toHaveBeenCalled();
    });

    it('PUT /:conversationId/:messageId calls the Mongo model, never the sovereign HTTP boundary', async () => {
      getMessages.mockResolvedValueOnce([{ conversationId: 'c1', isCreatedByUser: true }]);
      updateMessage.mockResolvedValueOnce({ messageId: 'm1' });
      await request(app).put('/api/messages/c1/m1').send({ text: 'edited' }).expect(200);
      expect(updateMessage).toHaveBeenCalled();
      expect(callConsoleConversationsProxy).not.toHaveBeenCalled();
    });

    it('DELETE /:conversationId/:messageId calls the Mongo model, never the sovereign HTTP boundary', async () => {
      deleteMessages.mockResolvedValueOnce({ deletedCount: 1 });
      await request(app).delete('/api/messages/c1/m1').expect(204);
      expect(deleteMessages).toHaveBeenCalledWith({
        messageId: 'm1',
        conversationId: 'c1',
        user: 'test-user-123',
      });
      expect(callConsoleConversationsProxy).not.toHaveBeenCalled();
    });
  });

  describe('sovereign flag', () => {
    beforeEach(() => {
      process.env.AUDITTRACE_MEMORY_BACKEND = 'sovereign';
    });

    it('GET /:conversationId routes to the sovereign adapter and NEVER calls the Mongo model', async () => {
      callConsoleConversationsProxy.mockResolvedValueOnce({
        items: [
          {
            message_id: 'm1',
            conversation_id: 'c1',
            sender: 'User',
            text: 'hi',
            is_created_by_user: true,
            created_at_ms: 0,
          },
        ],
      });
      const res = await request(app).get('/api/messages/c1').expect(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].messageId).toBe('m1');
      expect(callConsoleConversationsProxy).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'GET', path: 'c1/messages' }),
      );
      expect(getMessages).not.toHaveBeenCalled();
    });

    it('POST /:conversationId routes the message+convo write to the sovereign adapter and NEVER calls the Mongo model', async () => {
      callConsoleConversationsProxy
        .mockResolvedValueOnce({
          message_id: 'm1',
          conversation_id: 'c1',
          sender: 'User',
          text: 'hi',
          is_created_by_user: true,
          created_at_ms: 0,
        }) // saveMessage POST
        .mockImplementationOnce(NOT_FOUND) // saveConvo existing-fetch GET (brand new)
        .mockResolvedValueOnce({
          conversation_id: 'c1',
          title: 't',
          is_temporary: false,
          created_at_ms: 0,
          updated_at_ms: 0,
          metadata: {},
        }); // saveConvo POST
      const res = await request(app)
        .post('/api/messages/c1')
        .send({ messageId: 'm1', text: 'hi', isCreatedByUser: true })
        .expect(201);
      expect(res.body.messageId).toBe('m1');
      expect(callConsoleConversationsProxy).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'POST', path: 'c1/messages' }),
      );
      expect(callConsoleConversationsProxy).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'POST', path: '' }),
      );
      expect(saveMessage).not.toHaveBeenCalled();
      expect(saveConvo).not.toHaveBeenCalled();
    });

    it('GET /:conversationId/:messageId routes to the sovereign adapter and NEVER calls the Mongo model', async () => {
      callConsoleConversationsProxy.mockResolvedValueOnce({
        items: [
          {
            message_id: 'm1',
            conversation_id: 'c1',
            sender: 'User',
            text: 'hi',
            is_created_by_user: true,
            created_at_ms: 0,
          },
        ],
      });
      const res = await request(app).get('/api/messages/c1/m1').expect(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].messageId).toBe('m1');
      expect(callConsoleConversationsProxy).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'GET', path: 'c1/messages' }),
      );
      expect(getMessages).not.toHaveBeenCalled();
    });

    it('PUT /:conversationId/:messageId routes the text edit to the sovereign adapter and NEVER calls the Mongo model', async () => {
      callConsoleConversationsProxy
        .mockResolvedValueOnce({
          items: [
            {
              message_id: 'm1',
              conversation_id: 'c1',
              sender: 'User',
              text: 'hi',
              is_created_by_user: true,
              created_at_ms: 0,
            },
          ],
        }) // getMessages (fetch before edit)
        .mockImplementationOnce(NOT_FOUND) // updateMessage existing-fetch GET
        .mockResolvedValueOnce({
          message_id: 'm1',
          conversation_id: 'c1',
          sender: 'User',
          text: 'edited',
          is_created_by_user: true,
          created_at_ms: 0,
        }); // updateMessage PATCH
      const res = await request(app)
        .put('/api/messages/c1/m1')
        .send({ text: 'edited' })
        .expect(200);
      expect(res.body.text).toBe('edited');
      expect(callConsoleConversationsProxy).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'PATCH', path: 'c1/messages/m1' }),
      );
      expect(updateMessage).not.toHaveBeenCalled();
    });

    it('DELETE /:conversationId/:messageId routes to the sovereign adapter and NEVER calls the Mongo model', async () => {
      callConsoleConversationsProxy.mockResolvedValueOnce(undefined);
      await request(app).delete('/api/messages/c1/m1').expect(204);
      expect(callConsoleConversationsProxy).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'DELETE', path: 'c1/messages/m1' }),
      );
      expect(deleteMessages).not.toHaveBeenCalled();
    });
  });
});
