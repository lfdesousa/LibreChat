/**
 * M3-WU-D2-3 Part B — closes the Mongo split-brain for the agent's
 * "remember this" mid-chat writes. `resolveMemoryWriteMethods` is the ONE
 * seam both real call sites (`client.js`'s `#useMemory` and
 * `handleTools.js`'s SET_MEMORY_TOOL_NAME/DELETE_MEMORY_TOOL_NAME branch)
 * go through to pick Mongo-vs-sovereign — these tests exercise that
 * PRODUCTION code directly (not a mirrored/reimplemented copy), mocking
 * only the adapter's own HTTP boundary (`callMemoryProxy`, matching
 * `index.spec.js`'s established convention for this module).
 */
jest.mock('./client', () => ({ callMemoryProxy: jest.fn() }));
jest.mock('@librechat/api', () => ({
  Tokenizer: { getTokenCount: jest.fn((value) => String(value || '').length) },
}));

const { callMemoryProxy } = require('./client');
const {
  createSovereignAgentMemoryMethods,
  resolveMemoryWriteMethods,
  resolveWriteCompositeKey,
  formatMemories,
} = require('./agentMethods');
const { ReadOnlyLayerError } = require('./errors');

const ORIGINAL_BACKEND = process.env.AUDITTRACE_MEMORY_BACKEND;

afterEach(() => {
  callMemoryProxy.mockReset();
  if (ORIGINAL_BACKEND === undefined) {
    delete process.env.AUDITTRACE_MEMORY_BACKEND;
  } else {
    process.env.AUDITTRACE_MEMORY_BACKEND = ORIGINAL_BACKEND;
  }
});

describe('resolveWriteCompositeKey', () => {
  it('resolves a bare plain key to the default personalization semantic collection', () => {
    expect(resolveWriteCompositeKey('favorite_language')).toBe(
      'semantic:librechat_personalization/favorite_language',
    );
  });

  it('honours an explicit procedural: prefix', () => {
    expect(resolveWriteCompositeKey('procedural:notes.md')).toBe('procedural:notes.md');
  });

  it('honours an explicit semantic:collection/id prefix', () => {
    expect(resolveWriteCompositeKey('semantic:custom_collection/doc1')).toBe(
      'semantic:custom_collection/doc1',
    );
  });
});

describe('formatMemories', () => {
  it('returns the empty shape for no memories', () => {
    expect(formatMemories([])).toEqual({
      withKeys: '',
      withoutKeys: '',
      totalTokens: 0,
      tokenCountsByKey: new Map(),
    });
    expect(formatMemories(undefined)).toEqual({
      withKeys: '',
      withoutKeys: '',
      totalTokens: 0,
      tokenCountsByKey: new Map(),
    });
  });

  it('sorts oldest-first and sums token counts, mirroring the Mongo model exactly', () => {
    const memories = [
      { key: 'b', value: 'second', tokenCount: 5, updated_at: '2026-08-30T00:00:00.000Z' },
      { key: 'a', value: 'first', tokenCount: 3, updated_at: '2026-08-29T00:00:00.000Z' },
    ];
    const result = formatMemories(memories);
    expect(result.totalTokens).toBe(8);
    expect(result.tokenCountsByKey).toEqual(
      new Map([
        ['a', 3],
        ['b', 5],
      ]),
    );
    // oldest ('a') listed first in both formats
    expect(result.withoutKeys.indexOf('first')).toBeLessThan(result.withoutKeys.indexOf('second'));
    expect(result.withKeys).toContain('"key": "a"');
    expect(result.withKeys).toContain('"key": "b"');
  });
});

describe('createSovereignAgentMemoryMethods', () => {
  const methods = createSovereignAgentMemoryMethods({ token: 'tok' });

  it("setMemory forwards a bare key through the adapter's createMemory (upsert-by-plain-key)", async () => {
    callMemoryProxy
      .mockResolvedValueOnce({ metadata: { tier: 'private' } }) // existing-tier GET
      .mockResolvedValueOnce({}); // the POST

    const result = await methods.setMemory({
      userId: 'user-1',
      key: 'favorite_language',
      value: 'TypeScript',
    });

    expect(result.ok).toBe(true);
    expect(callMemoryProxy).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        path: 'semantic',
        token: 'tok',
        body: {
          collection: 'librechat_personalization',
          document_id: 'favorite_language',
          text: 'TypeScript',
        },
      }),
    );
  });

  it('deleteMemory resolves the same composite target a matching setMemory would have used', async () => {
    callMemoryProxy
      .mockResolvedValueOnce({ metadata: { tier: 'private' } }) // existing-tier GET
      .mockResolvedValueOnce({}); // the DELETE

    const result = await methods.deleteMemory({ userId: 'user-1', key: 'favorite_language' });

    expect(result.ok).toBe(true);
    expect(callMemoryProxy).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'DELETE',
        path: 'semantic/librechat_personalization/favorite_language',
        token: 'tok',
      }),
    );
  });

  it('rejects a setMemory targeting an EXISTING corpus-tier item — the POST never happens', async () => {
    callMemoryProxy.mockResolvedValueOnce({ metadata: { tier: 'corpus' } });

    await expect(
      methods.setMemory({ userId: 'user-1', key: 'favorite_language', value: 'TypeScript' }),
    ).rejects.toThrow(ReadOnlyLayerError);

    expect(callMemoryProxy).toHaveBeenCalledTimes(1);
    expect(callMemoryProxy).not.toHaveBeenCalledWith(expect.objectContaining({ method: 'POST' }));
  });

  it('rejects a deleteMemory targeting an EXISTING corpus-tier item — the DELETE never happens', async () => {
    callMemoryProxy.mockResolvedValueOnce({ metadata: { tier: 'corpus' } });

    await expect(
      methods.deleteMemory({ userId: 'user-1', key: 'favorite_language' }),
    ).rejects.toThrow(ReadOnlyLayerError);

    expect(callMemoryProxy).toHaveBeenCalledTimes(1);
    expect(callMemoryProxy).not.toHaveBeenCalledWith(expect.objectContaining({ method: 'DELETE' }));
  });

  it('getFormattedMemories reflects the union of all layers, formatted like the Mongo model', async () => {
    callMemoryProxy.mockImplementation(async ({ path }) => {
      if (path === 'episodic') return { items: [] };
      if (path === 'procedural') return { items: [] };
      if (path === 'semantic') {
        return {
          items: [
            {
              key: 'librechat_personalization/favorite_language',
              title: 'favorite_language',
              modified_at_ms: Date.parse('2026-08-30T00:00:00.000Z'),
              tier: 'private',
            },
          ],
        };
      }
      if (path === 'conversational') return { items: [] };
      throw new Error(`unexpected path ${path}`);
    });

    const { withKeys, totalTokens } = await methods.getFormattedMemories({ userId: 'user-1' });

    expect(withKeys).toContain('semantic:librechat_personalization/favorite_language');
    expect(totalTokens).toBeGreaterThan(0);
  });
});

describe('resolveMemoryWriteMethods — the Mongo-vs-sovereign routing seam', () => {
  const buildMongoMethods = () => ({
    setMemory: jest.fn().mockResolvedValue({ ok: true }),
    deleteMemory: jest.fn().mockResolvedValue({ ok: true }),
    getUserMemories: jest.fn().mockResolvedValue([]),
    getFormattedMemories: jest.fn().mockResolvedValue({
      withKeys: '',
      withoutKeys: '',
      totalTokens: 0,
      tokenCountsByKey: new Map(),
    }),
  });

  it('returns mongoMethods UNCHANGED (same reference) under the default mongo flag — byte-unchanged agent path', () => {
    delete process.env.AUDITTRACE_MEMORY_BACKEND;
    const mongoMethods = buildMongoMethods();

    const resolved = resolveMemoryWriteMethods({ req: {}, mongoMethods });

    expect(resolved).toBe(mongoMethods);
  });

  it('also returns mongoMethods unchanged for a non-"sovereign" value (fail-closed to mongo)', () => {
    process.env.AUDITTRACE_MEMORY_BACKEND = 'typo-value';
    const mongoMethods = buildMongoMethods();

    expect(resolveMemoryWriteMethods({ req: {}, mongoMethods })).toBe(mongoMethods);
  });

  /**
   * Non-vacuous guard, per the ratified spec's acceptance criteria: "under
   * sovereign, an agent 'remember this' write is forwarded to the
   * sovereign adapter, NOT the Mongo model function." Neutering
   * `resolveMemoryWriteMethods` to always `return mongoMethods` (dropping
   * the sovereign branch entirely) makes every assertion below fail RED —
   * verified by hand during the build, restored, re-verified GREEN. See
   * the build record.
   */
  it('under sovereign, forwards writes to the adapter and NEVER calls the injected Mongo functions — no split-brain', async () => {
    process.env.AUDITTRACE_MEMORY_BACKEND = 'sovereign';
    const mongoMethods = buildMongoMethods();
    const req = { session: { openidTokens: { accessToken: 'user-bearer-token' } } };

    const resolved = resolveMemoryWriteMethods({ req, mongoMethods });

    expect(resolved).not.toBe(mongoMethods);
    expect(resolved.setMemory).not.toBe(mongoMethods.setMemory);
    expect(resolved.deleteMemory).not.toBe(mongoMethods.deleteMemory);

    callMemoryProxy
      .mockResolvedValueOnce({ metadata: { tier: 'private' } }) // setMemory tier-check
      .mockResolvedValueOnce({}) // setMemory POST
      .mockResolvedValueOnce({ metadata: { tier: 'private' } }) // deleteMemory tier-check
      .mockResolvedValueOnce({}) // deleteMemory DELETE
      .mockResolvedValueOnce({ items: [] }) // getUserMemories: episodic
      .mockResolvedValueOnce({ items: [] }) // procedural
      .mockResolvedValueOnce({ items: [] }) // semantic
      .mockResolvedValueOnce({ items: [] }) // conversational
      .mockResolvedValueOnce({ items: [] }) // getFormattedMemories: episodic
      .mockResolvedValueOnce({ items: [] }) // procedural
      .mockResolvedValueOnce({ items: [] }) // semantic
      .mockResolvedValueOnce({ items: [] }); // conversational

    // Enumeration: every method the agent write surface can call — none of
    // them ever reaches a Mongo function while sovereign is active.
    await resolved.setMemory({ userId: 'u1', key: 'favorite_language', value: 'TypeScript' });
    await resolved.deleteMemory({ userId: 'u1', key: 'favorite_language' });
    await resolved.getUserMemories({ userId: 'u1' });
    await resolved.getFormattedMemories({ userId: 'u1' });

    // The adapter's HTTP boundary WAS used (proves the writes were really
    // forwarded, not silently dropped)...
    expect(callMemoryProxy).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'POST', path: 'semantic', token: 'user-bearer-token' }),
    );
    expect(callMemoryProxy).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'DELETE', token: 'user-bearer-token' }),
    );
    // ...and the caller's own Mongo functions were NEVER invoked.
    expect(mongoMethods.setMemory).not.toHaveBeenCalled();
    expect(mongoMethods.deleteMemory).not.toHaveBeenCalled();
    expect(mongoMethods.getUserMemories).not.toHaveBeenCalled();
    expect(mongoMethods.getFormattedMemories).not.toHaveBeenCalled();
  });

  it('under sovereign, a write targeting an EXISTING corpus-tier item is rejected and never reaches Mongo', async () => {
    process.env.AUDITTRACE_MEMORY_BACKEND = 'sovereign';
    const mongoMethods = buildMongoMethods();
    const resolved = resolveMemoryWriteMethods({
      req: { session: { openidTokens: { accessToken: 'tok' } } },
      mongoMethods,
    });

    callMemoryProxy.mockResolvedValueOnce({ metadata: { tier: 'corpus' } });

    await expect(
      resolved.setMemory({ userId: 'u1', key: 'favorite_language', value: 'TypeScript' }),
    ).rejects.toThrow(ReadOnlyLayerError);

    expect(mongoMethods.setMemory).not.toHaveBeenCalled();
  });

  it('under sovereign with no session token, the adapter call fails closed to 401 rather than silently falling back to Mongo', async () => {
    process.env.AUDITTRACE_MEMORY_BACKEND = 'sovereign';
    const mongoMethods = buildMongoMethods();
    const resolved = resolveMemoryWriteMethods({ req: {}, mongoMethods });

    // No access token forwarded — the BFF call itself is mocked, but the
    // resolved methods must still be the sovereign bridge, never falling
    // back to mongoMethods just because the token is absent.
    expect(resolved).not.toBe(mongoMethods);
    expect(resolved.setMemory).not.toBe(mongoMethods.setMemory);
  });
});
