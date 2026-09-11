/**
 * Route-level dispatch test for MongoDB-elimination WU-2 (2026-09-11
 * exhaustive-audit remediation) — `middleware/messageValidation.js`'s
 * `getConvo` dependency used to be bound to the raw Mongo
 * `getConvoOwnership` ONCE, at module load, before any request/token
 * existed. Every route this validation gates
 * (`routes/messages.js`'s `GET/PUT/DELETE /:conversationId/:messageId`,
 * `GET /:conversationId`) had already been wired to read/write the
 * sovereign store for its OWN persistence, but this shared ownership
 * check still ran against Mongo only — a sovereign-only conversation
 * 404'd HERE, before the wired handler's own sovereign read/write ever
 * ran. This file proves the fix: the ownership check is now resolved
 * PER REQUEST via the same `resolveConversationMethods` seam every other
 * wired call site uses.
 */
jest.mock('~/models', () => ({
  getConvoOwnership: jest.fn(),
}));

jest.mock('@librechat/api', () => ({
  createMessageRequestMiddleware:
    jest.requireActual('@librechat/api').createMessageRequestMiddleware,
  GenerationJobManager: {
    getJob: jest.fn(),
  },
  isPendingActionStale: jest.fn(() => false),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn() },
}));

jest.mock('~/server/services/AuditTraceConversations/client', () => ({
  callConsoleConversationsProxy: jest.fn(),
}));

const { validateMessageReq, prepareMessageRequestValidation } = require('../messageValidation');
const { getConvoOwnership } = require('~/models');
const {
  callConsoleConversationsProxy,
} = require('~/server/services/AuditTraceConversations/client');

function createResponse() {
  const res = { json: jest.fn(), send: jest.fn(), status: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe('messageValidation — sovereign backend dispatch (MongoDB-elimination WU-2)', () => {
  const ORIGINAL_BACKEND = process.env.AUDITTRACE_MEMORY_BACKEND;
  const userId = 'user-123';

  afterEach(() => {
    jest.clearAllMocks();
    if (ORIGINAL_BACKEND === undefined) {
      delete process.env.AUDITTRACE_MEMORY_BACKEND;
    } else {
      process.env.AUDITTRACE_MEMORY_BACKEND = ORIGINAL_BACKEND;
    }
  });

  describe('validateMessageReq', () => {
    it('under the default flag, calls getConvoOwnership unchanged (byte-identical path)', async () => {
      delete process.env.AUDITTRACE_MEMORY_BACKEND;
      const req = {
        params: { conversationId: 'convo-owned' },
        body: { conversationId: 'convo-owned' },
        user: { id: userId },
      };
      const res = createResponse();
      const next = jest.fn();
      getConvoOwnership.mockResolvedValue({ conversationId: 'convo-owned', user: userId });

      await validateMessageReq(req, res, next);

      expect(getConvoOwnership).toHaveBeenCalledWith(userId, 'convo-owned');
      expect(callConsoleConversationsProxy).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledTimes(1);
    });

    /**
     * NON-VACUOUS guard: verified by hand that reverting this fix
     * (binding `getConvo: getConvoOwnership` once at module load, as
     * before) turns this RED — the sovereign HTTP boundary is never hit,
     * and a sovereign-only conversation 404s instead of validating.
     */
    it('under sovereign, resolves ownership via the sovereign adapter and NEVER calls the Mongo model', async () => {
      process.env.AUDITTRACE_MEMORY_BACKEND = 'sovereign';
      const req = {
        params: { conversationId: 'convo-owned' },
        body: { conversationId: 'convo-owned' },
        user: { id: userId },
        session: { openidTokens: { accessToken: 'user-bearer-token' } },
      };
      const res = createResponse();
      const next = jest.fn();
      callConsoleConversationsProxy.mockResolvedValue({
        conversation_id: 'convo-owned',
        title: 't',
        is_temporary: false,
        created_at_ms: 0,
        updated_at_ms: 0,
        metadata: {},
      });

      await validateMessageReq(req, res, next);

      expect(callConsoleConversationsProxy).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'GET', path: 'convo-owned', token: 'user-bearer-token' }),
      );
      expect(getConvoOwnership).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('under sovereign, a conversation absent from the sovereign store 404s (never silently passes)', async () => {
      process.env.AUDITTRACE_MEMORY_BACKEND = 'sovereign';
      const req = {
        method: 'GET',
        params: { conversationId: 'missing' },
        body: {},
        user: { id: userId },
        session: { openidTokens: { accessToken: 'tok' } },
      };
      const res = createResponse();
      const next = jest.fn();
      const { SovereignMemoryError } = require('~/server/services/AuditTraceMemory/errors');
      callConsoleConversationsProxy.mockRejectedValue(new SovereignMemoryError('gone', 404));

      await validateMessageReq(req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('prepareMessageRequestValidation', () => {
    it('under sovereign, the deferred validation promise resolves via the sovereign adapter', async () => {
      process.env.AUDITTRACE_MEMORY_BACKEND = 'sovereign';
      const req = {
        params: { conversationId: 'convo-owned' },
        body: {},
        user: { id: userId },
        session: { openidTokens: { accessToken: 'user-bearer-token' } },
      };
      const res = createResponse();
      const next = jest.fn();
      callConsoleConversationsProxy.mockResolvedValue({
        conversation_id: 'convo-owned',
        title: 't',
        is_temporary: false,
        created_at_ms: 0,
        updated_at_ms: 0,
        metadata: {},
      });

      prepareMessageRequestValidation(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);

      const result = await req.messageRequestValidation.promise;
      expect(result).toEqual({ ok: true });
      expect(callConsoleConversationsProxy).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'GET', path: 'convo-owned', token: 'user-bearer-token' }),
      );
      expect(getConvoOwnership).not.toHaveBeenCalled();
    });
  });
});
