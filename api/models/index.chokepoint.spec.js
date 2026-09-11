/**
 * Integration test for the ACTUAL wiring point (MongoDB-elimination
 * WU-2b): `api/models/index.js` must apply
 * `AuditTraceConversations::wrapModelMethods` to the real
 * `createMethods(...)` output before exporting it, so that
 * `require('~/models')` — however a caller obtains and uses that
 * reference (a route, `utils/import/fork.js`'s `const db =
 * require('~/models')`, or an injected `methods` constructor param like
 * `services/Schedules/index.js`'s) — always resolves through the
 * chokepoint. Mocks ONLY `createMethods` (the raw Mongo methods) and the
 * adapter's own HTTP boundary (`AuditTraceConversations/client`) — the
 * chokepoint wiring itself (`wrapModelMethods`, `api/models/index.js`)
 * is REAL, unmocked code.
 */
const mockSaveConvo = jest.fn();
const mockGetUserById = jest.fn();

jest.mock('mongoose', () => ({}));
jest.mock('@librechat/data-schemas', () => ({
  createMethods: jest.fn(() => ({
    saveConvo: mockSaveConvo,
    getUserById: mockGetUserById,
  })),
}));
jest.mock('@librechat/api', () => ({
  matchModelName: jest.fn(),
  findMatchingPattern: jest.fn(),
  isDeploymentSkillId: jest.fn(),
}));
jest.mock('~/cache/getLogStores', () => jest.fn());
jest.mock('~/server/services/AuditTraceConversations/client', () => ({
  callConsoleConversationsProxy: jest.fn(),
}));

const {
  callConsoleConversationsProxy,
} = require('~/server/services/AuditTraceConversations/client');
const {
  runWithRequestAccessToken,
} = require('~/server/services/AuditTraceConversations/requestContext');
const { SovereignMemoryError } = require('~/server/services/AuditTraceMemory/errors');

const ORIGINAL_BACKEND = process.env.AUDITTRACE_MEMORY_BACKEND;

describe('api/models/index.js — the chokepoint is actually wired at the real export point', () => {
  afterEach(() => {
    jest.clearAllMocks();
    if (ORIGINAL_BACKEND === undefined) {
      delete process.env.AUDITTRACE_MEMORY_BACKEND;
    } else {
      process.env.AUDITTRACE_MEMORY_BACKEND = ORIGINAL_BACKEND;
    }
  });

  it('exports saveConvo wrapped: default flag calls the raw Mongo method unchanged', async () => {
    delete process.env.AUDITTRACE_MEMORY_BACKEND;
    const models = require('./index');
    await models.saveConvo({}, { conversationId: 'c1' }, {});
    expect(mockSaveConvo).toHaveBeenCalledWith({}, { conversationId: 'c1' }, {});
    expect(callConsoleConversationsProxy).not.toHaveBeenCalled();
  });

  it('a non-conversation export (getUserById) is untouched — same function reference', () => {
    const models = require('./index');
    expect(models.getUserById).toBe(mockGetUserById);
  });

  it('under sovereign WITH a request-context token, require("~/models").saveConvo routes to the sovereign adapter and NEVER calls the raw Mongo function', async () => {
    process.env.AUDITTRACE_MEMORY_BACKEND = 'sovereign';
    const models = require('./index');
    callConsoleConversationsProxy
      .mockRejectedValueOnce(new SovereignMemoryError('not found', 404)) // existing-fetch
      .mockResolvedValueOnce({
        conversation_id: 'c1',
        title: 't',
        is_temporary: false,
        created_at_ms: 0,
        updated_at_ms: 0,
        metadata: {},
      });

    const result = await runWithRequestAccessToken({ accessToken: 'user-bearer-token' }, () =>
      models.saveConvo({ userId: 'u1' }, { conversationId: 'c1' }, {}),
    );

    expect(result.conversationId).toBe('c1');
    expect(callConsoleConversationsProxy).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'user-bearer-token' }),
    );
    expect(mockSaveConvo).not.toHaveBeenCalled();
  });

  it('under sovereign with NO request-context token (a background/scheduled job), falls to the raw Mongo function — the disclosed boundary', async () => {
    process.env.AUDITTRACE_MEMORY_BACKEND = 'sovereign';
    const models = require('./index');

    await models.saveConvo({ userId: 'u1' }, { conversationId: 'c1' }, {});

    expect(mockSaveConvo).toHaveBeenCalledWith({ userId: 'u1' }, { conversationId: 'c1' }, {});
    expect(callConsoleConversationsProxy).not.toHaveBeenCalled();
  });
});
