/**
 * Integration test for the ACTUAL wiring point (MongoDB-elimination
 * WU-2b, extended by WU-presets 2026-09-11 — the FIRST reuse of this
 * chokepoint — and by WU-prompts the SAME day — the SECOND reuse):
 * `api/models/index.js` must apply
 * `AuditTraceConversations::wrapModelMethods` to the real
 * `createMethods(...)` output before exporting it, so that
 * `require('~/models')` — however a caller obtains and uses that
 * reference (a route, `utils/import/fork.js`'s `const db =
 * require('~/models')`, an injected `methods` constructor param like
 * `services/Schedules/index.js`'s, or `UserController.js`'s own
 * module-load-time `const db = require('~/models')`) — always resolves
 * through the chokepoint, for the conversation/message methods (WU-2b),
 * the preset methods (WU-presets), AND the prompt methods (WU-prompts).
 * Mocks ONLY `createMethods` (the raw Mongo methods) and the adapters'
 * own HTTP boundaries (`AuditTraceConversations/client`,
 * `AuditTracePresets/client`, `AuditTracePrompts/client`) — the
 * chokepoint wiring itself (`wrapModelMethods`, `api/models/index.js`)
 * is REAL, unmocked code.
 */
const mockSaveConvo = jest.fn();
const mockDeletePresets = jest.fn();
const mockDeleteUserPrompts = jest.fn();
const mockGetUserById = jest.fn();

jest.mock('mongoose', () => ({}));
jest.mock('@librechat/data-schemas', () => ({
  createMethods: jest.fn(() => ({
    saveConvo: mockSaveConvo,
    deletePresets: mockDeletePresets,
    deleteUserPrompts: mockDeleteUserPrompts,
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
jest.mock('~/server/services/AuditTracePresets/client', () => ({
  callConsolePresetsProxy: jest.fn(),
}));
jest.mock('~/server/services/AuditTracePrompts/client', () => ({
  callConsolePromptsProxy: jest.fn(),
}));

const {
  callConsoleConversationsProxy,
} = require('~/server/services/AuditTraceConversations/client');
const { callConsolePresetsProxy } = require('~/server/services/AuditTracePresets/client');
const { callConsolePromptsProxy } = require('~/server/services/AuditTracePrompts/client');
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

  // ── WU-presets (2026-09-11) — the FIRST reuse of this chokepoint ──────

  it('exports deletePresets wrapped: default flag calls the raw Mongo method unchanged', async () => {
    delete process.env.AUDITTRACE_MEMORY_BACKEND;
    const models = require('./index');
    await models.deletePresets('u1', {});
    expect(mockDeletePresets).toHaveBeenCalledWith('u1', {});
    expect(callConsolePresetsProxy).not.toHaveBeenCalled();
  });

  it('under sovereign WITH a request-context token, require("~/models").deletePresets routes to the sovereign preset adapter and NEVER calls the raw Mongo function', async () => {
    process.env.AUDITTRACE_MEMORY_BACKEND = 'sovereign';
    const models = require('./index');
    callConsolePresetsProxy.mockResolvedValueOnce({});

    const result = await runWithRequestAccessToken({ accessToken: 'user-bearer-token' }, () =>
      models.deletePresets('u1', { presetId: 'p1' }),
    );

    expect(result).toEqual({ acknowledged: true, deletedCount: 1 });
    expect(callConsolePresetsProxy).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'user-bearer-token', method: 'DELETE', path: 'p1' }),
    );
    expect(mockDeletePresets).not.toHaveBeenCalled();
  });

  it('under sovereign with NO request-context token (a background job), deletePresets falls to the raw Mongo function — the SAME disclosed boundary as conversations', async () => {
    process.env.AUDITTRACE_MEMORY_BACKEND = 'sovereign';
    const models = require('./index');

    await models.deletePresets('u1', {});

    expect(mockDeletePresets).toHaveBeenCalledWith('u1', {});
    expect(callConsolePresetsProxy).not.toHaveBeenCalled();
  });

  it('the WU-2b `schedules.js`/`UserController.js` injected-reference trap: a `~/models` reference captured ONCE at module load (e.g. `const db = require("~/models")`) still routes deletePresets through the chokepoint on every later call, because Node caches the module and wrapModelMethods dispatches AT CALL TIME, not at wrap time', async () => {
    process.env.AUDITTRACE_MEMORY_BACKEND = 'sovereign';
    // Simulates `api/server/controllers/UserController.js`'s module-load-time
    // `const db = require('~/models')` — captured into a local binding
    // BEFORE any request-scoped token exists.
    const db = require('./index');
    callConsolePresetsProxy.mockResolvedValueOnce({});

    // First call: no live request (e.g. this module's own load-time code
    // path) — falls to Mongo, per the disclosed boundary.
    await db.deletePresets('u1', {});
    expect(mockDeletePresets).toHaveBeenCalledTimes(1);
    expect(callConsolePresetsProxy).not.toHaveBeenCalled();

    // A LATER call, from inside a real request's handler, using the SAME
    // captured `db` reference — routes to sovereign because the wrapper
    // reads the request context fresh on every invocation.
    const result = await runWithRequestAccessToken({ accessToken: 'later-token' }, () =>
      db.deletePresets('u1', { presetId: 'p1' }),
    );
    expect(result).toEqual({ acknowledged: true, deletedCount: 1 });
    expect(callConsolePresetsProxy).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'later-token' }),
    );
    // The earlier Mongo call is still the only Mongo call — the SAME `db`
    // reference correctly serves both backends across its lifetime.
    expect(mockDeletePresets).toHaveBeenCalledTimes(1);
  });

  it('a non-conversation, non-preset export (getUserById) is STILL untouched — same function reference', () => {
    const models = require('./index');
    expect(models.getUserById).toBe(mockGetUserById);
  });

  // ── WU-prompts (2026-09-11) — the SECOND reuse of this chokepoint ─────

  it('exports deleteUserPrompts wrapped: default flag calls the raw Mongo method unchanged', async () => {
    delete process.env.AUDITTRACE_MEMORY_BACKEND;
    const models = require('./index');
    await models.deleteUserPrompts('u1');
    expect(mockDeleteUserPrompts).toHaveBeenCalledWith('u1');
    expect(callConsolePromptsProxy).not.toHaveBeenCalled();
  });

  it('under sovereign WITH a request-context token, require("~/models").deleteUserPrompts routes to the sovereign prompt adapter and NEVER calls the raw Mongo function', async () => {
    process.env.AUDITTRACE_MEMORY_BACKEND = 'sovereign';
    const models = require('./index');
    callConsolePromptsProxy.mockResolvedValueOnce({ items: [], next_cursor: null });

    await runWithRequestAccessToken({ accessToken: 'user-bearer-token' }, () =>
      models.deleteUserPrompts('u1'),
    );

    expect(callConsolePromptsProxy).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'user-bearer-token', method: 'GET' }),
    );
    expect(mockDeleteUserPrompts).not.toHaveBeenCalled();
  });

  it('under sovereign with NO request-context token (a background job), deleteUserPrompts falls to the raw Mongo function — the SAME disclosed boundary as conversations/presets', async () => {
    process.env.AUDITTRACE_MEMORY_BACKEND = 'sovereign';
    const models = require('./index');

    await models.deleteUserPrompts('u1');

    expect(mockDeleteUserPrompts).toHaveBeenCalledWith('u1');
    expect(callConsolePromptsProxy).not.toHaveBeenCalled();
  });

  it('the WU-2b `UserController.js` injected-reference trap: a `~/models` reference captured ONCE at module load still routes deleteUserPrompts through the chokepoint on every later call, because Node caches the module and wrapModelMethods dispatches AT CALL TIME, not at wrap time', async () => {
    process.env.AUDITTRACE_MEMORY_BACKEND = 'sovereign';
    // Simulates `api/server/controllers/UserController.js`'s module-load-time
    // `const db = require('~/models')` — captured into a local binding
    // BEFORE any request-scoped token exists.
    const db = require('./index');
    callConsolePromptsProxy.mockResolvedValueOnce({ items: [], next_cursor: null });

    // First call: no live request — falls to Mongo, per the disclosed boundary.
    await db.deleteUserPrompts('u1');
    expect(mockDeleteUserPrompts).toHaveBeenCalledTimes(1);
    expect(callConsolePromptsProxy).not.toHaveBeenCalled();

    // A LATER call, from inside a real request's handler, using the SAME
    // captured `db` reference — routes to sovereign because the wrapper
    // reads the request context fresh on every invocation.
    callConsolePromptsProxy.mockResolvedValueOnce({ items: [], next_cursor: null });
    await runWithRequestAccessToken({ accessToken: 'later-token' }, () =>
      db.deleteUserPrompts('u1'),
    );
    expect(callConsolePromptsProxy).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'later-token' }),
    );
    // The earlier Mongo call is still the only Mongo call — the SAME `db`
    // reference correctly serves both backends across its lifetime.
    expect(mockDeleteUserPrompts).toHaveBeenCalledTimes(1);
  });

  it('a prompt ACL/sharing export (invalidatePromptGroupAccessContext) has NO binder — untouched even under sovereign (disclosed category, not a gap)', async () => {
    process.env.AUDITTRACE_MEMORY_BACKEND = 'sovereign';
    // Not present on the mocked createMethods() output either — this test
    // asserts wrapModelMethods never INVENTS a binder-driven wrapper for a
    // name with no `ALL_SOVEREIGN_METHOD_BINDERS` entry (the ACL/sharing
    // family is deliberately unwired — see `AuditTracePrompts/index.js`'s
    // docstring's "DISCLOSED CATEGORY 1").
    const models = require('./index');
    expect(models.invalidatePromptGroupAccessContext).toBeUndefined();
  });

  it('a non-conversation, non-preset, non-prompt export (getUserById) is STILL untouched — same function reference', () => {
    const models = require('./index');
    expect(models.getUserById).toBe(mockGetUserById);
  });
});
