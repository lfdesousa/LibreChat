/**
 * M3-WU-D2-3 Part B — the REAL `loadTools` wiring for the inline
 * `set_memory`/`delete_memory` tools. Unlike `agentMethods.spec.js` (which
 * tests the routing seam in isolation), this exercises the ACTUAL call
 * site in `handleTools.js`: `~/models`'s `setMemory`/`deleteMemory` are
 * mocked as spies (the thing that must NEVER be called under `sovereign`),
 * `@librechat/api`'s `buildInlineMemoryTool` is spied (not reimplemented —
 * `jest.requireActual` backs everything else) so its call arguments —
 * specifically which `memoryMethods` object it received — are inspectable
 * without needing a full LangChain tool build or a real user/permission
 * round-trip.
 */
const mockBuildInlineMemoryTool = jest.fn(async () => ({ name: 'set_memory' }));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  buildInlineMemoryTool: (...args) => mockBuildInlineMemoryTool(...args),
}));

const mockSetMemory = jest.fn().mockResolvedValue({ ok: true });
const mockDeleteMemory = jest.fn().mockResolvedValue({ ok: true });
const mockGetFormattedMemories = jest.fn().mockResolvedValue({
  withKeys: '',
  withoutKeys: '',
  totalTokens: 0,
  tokenCountsByKey: new Map(),
});
const mockGetRoleByName = jest.fn();

/**
 * Exposes the SAME `mockXxx` function objects as the module's properties
 * (not wrapper closures around them) so a `.toBe(mockSetMemory)` identity
 * check downstream can prove `handleTools.js` handed `buildInlineMemoryTool`
 * these EXACT functions under the default mongo flag — a wrapper closure
 * would still be call-trackable but would defeat that identity proof.
 */
jest.mock('~/models', () => ({
  getRoleByName: mockGetRoleByName,
  setMemory: mockSetMemory,
  deleteMemory: mockDeleteMemory,
  getFormattedMemories: mockGetFormattedMemories,
}));

jest.mock('~/server/services/MCP', () => ({
  createMCPPermissionContext: jest.fn(() => ({
    canUseServers: jest.fn().mockResolvedValue(true),
  })),
  resolveConfigServers: jest.fn().mockResolvedValue({}),
  resolveMcpServerContext: jest.fn(async () => ({ configServers: {}, serverNames: [] })),
  resolveCollisionAuditNames: jest.fn(async () => ({ names: [], complete: true })),
  createMCPTool: jest.fn(),
  createMCPTools: jest.fn(),
}));

jest.mock('~/server/services/Config', () => ({
  getMCPServerTools: jest.fn(),
  checkCapability: jest.fn().mockResolvedValue(false),
}));

jest.mock('~/config', () => ({
  getMCPServersRegistry: jest.fn(() => ({ getServerConfig: jest.fn() })),
}));

const { SET_MEMORY_TOOL_NAME, DELETE_MEMORY_TOOL_NAME } = require('@librechat/api');
const { loadTools } = require('./handleTools');

const ORIGINAL_BACKEND = process.env.AUDITTRACE_MEMORY_BACKEND;

afterEach(() => {
  jest.clearAllMocks();
  if (ORIGINAL_BACKEND === undefined) {
    delete process.env.AUDITTRACE_MEMORY_BACKEND;
  } else {
    process.env.AUDITTRACE_MEMORY_BACKEND = ORIGINAL_BACKEND;
  }
});

const loadMemoryToolFactory = async (toolName, req) => {
  const requestedTools = await loadTools({
    user: 'user-1',
    agent: { id: 'agent-1' },
    tools: [toolName],
    options: { req },
    returnMap: true,
  });
  return requestedTools[toolName];
};

describe('handleTools.js — SET_MEMORY_TOOL_NAME / DELETE_MEMORY_TOOL_NAME wiring', () => {
  it('under the default mongo flag, passes the REAL ~/models functions through unchanged', async () => {
    delete process.env.AUDITTRACE_MEMORY_BACKEND;
    const factory = await loadMemoryToolFactory(SET_MEMORY_TOOL_NAME, {});

    await factory();

    expect(mockBuildInlineMemoryTool).toHaveBeenCalledTimes(1);
    const { memoryMethods } = mockBuildInlineMemoryTool.mock.calls[0][0];
    expect(memoryMethods.setMemory).toBe(mockSetMemory);
    expect(memoryMethods.deleteMemory).toBe(mockDeleteMemory);
    expect(memoryMethods.getFormattedMemories).toBe(mockGetFormattedMemories);
  });

  /**
   * Non-vacuous guard: under `sovereign`, `handleTools.js` must NEVER hand
   * the real `~/models` functions to `buildInlineMemoryTool`. Reverting
   * the `memoryMethods` line in `handleTools.js` back to the pre-D2-3-
   * Part-B literal (`{ setMemory, deleteMemory, getFormattedMemories }`)
   * makes this RED — verified by hand during the build, restored,
   * re-verified GREEN. See the build record.
   */
  it('under sovereign, passes the sovereign bridge — NEVER the raw ~/models functions', async () => {
    process.env.AUDITTRACE_MEMORY_BACKEND = 'sovereign';
    const req = { session: { openidTokens: { accessToken: 'user-bearer-token' } } };
    const factory = await loadMemoryToolFactory(SET_MEMORY_TOOL_NAME, req);

    await factory();

    expect(mockBuildInlineMemoryTool).toHaveBeenCalledTimes(1);
    const { memoryMethods } = mockBuildInlineMemoryTool.mock.calls[0][0];
    expect(memoryMethods.setMemory).not.toBe(mockSetMemory);
    expect(memoryMethods.deleteMemory).not.toBe(mockDeleteMemory);
    expect(memoryMethods.getFormattedMemories).not.toBe(mockGetFormattedMemories);

    // Calling the sovereign methods must never reach the Mongo spies either
    // (the routing decision, not just the object identity, is verified).
    await memoryMethods.getFormattedMemories({ userId: 'user-1' }).catch(() => {});
    expect(mockGetFormattedMemories).not.toHaveBeenCalled();
  });

  it('wires the delete_memory tool through the same sovereign bridge under sovereign', async () => {
    process.env.AUDITTRACE_MEMORY_BACKEND = 'sovereign';
    const req = { session: { openidTokens: { accessToken: 'tok' } } };
    const factory = await loadMemoryToolFactory(DELETE_MEMORY_TOOL_NAME, req);

    await factory();

    const { memoryMethods } = mockBuildInlineMemoryTool.mock.calls[0][0];
    expect(memoryMethods.deleteMemory).not.toBe(mockDeleteMemory);
  });
});
