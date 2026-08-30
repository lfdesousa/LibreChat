jest.mock('./client', () => ({ callMemoryProxy: jest.fn() }));
jest.mock('@librechat/api', () => ({
  Tokenizer: { getTokenCount: jest.fn((value) => String(value || '').length) },
}));

const { callMemoryProxy } = require('./client');
const {
  getAllUserMemories,
  createMemory,
  setMemory,
  deleteMemory,
  setMemoryById,
  deleteMemoryById,
} = require('./index');
const { parseCompositeKey } = require('./keyMapping');
const { ReadOnlyLayerError, InvalidCompositeKeyError } = require('./errors');

describe('AuditTraceMemory adapter (M3-WU-D2-2)', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getAllUserMemories — list unions the four layers and tags layer + readOnly', () => {
    it('maps every layer, deriving readOnly per the tier rule', async () => {
      callMemoryProxy.mockImplementation(async ({ path }) => {
        if (path === 'episodic') {
          return {
            items: [{ key: 'ADR-001.md', title: 'ADR 1', modified_at_ms: 100, tier: 'private' }],
          };
        }
        if (path === 'procedural') {
          return {
            items: [{ key: 'skill.md', title: 'Skill', modified_at_ms: 200, tier: 'private' }],
          };
        }
        if (path === 'semantic') {
          return {
            items: [
              {
                key: 'librechat_personalization/timezone',
                title: 'timezone',
                modified_at_ms: 300,
                tier: 'private',
              },
              {
                key: 'decisions_v2/shared-doc',
                title: 'shared',
                modified_at_ms: 400,
                tier: 'corpus',
              },
            ],
          };
        }
        if (path === 'conversational') {
          return { items: [{ id: 'sess-1', date: '2026-08-30', summary: 'a chat' }] };
        }
        throw new Error(`unexpected path ${path}`);
      });

      const memories = await getAllUserMemories({ userId: 'user-1', token: 'tok' });

      expect(memories).toHaveLength(5);
      const byLayer = Object.fromEntries(memories.map((m) => [m.layer + ':' + m.key, m]));

      expect(byLayer['episodic:episodic:ADR-001.md']).toMatchObject({
        layer: 'episodic',
        readOnly: true,
      });
      expect(byLayer['procedural:procedural:skill.md']).toMatchObject({
        layer: 'procedural',
        readOnly: false,
      });
      expect(byLayer['semantic:semantic:librechat_personalization/timezone']).toMatchObject({
        layer: 'semantic',
        readOnly: false,
      });
      expect(byLayer['semantic:semantic:decisions_v2/shared-doc']).toMatchObject({
        layer: 'semantic',
        readOnly: true, // corpus tier — read-only regardless of layer
      });
      expect(byLayer['conversational:conversational:sess-1']).toMatchObject({
        layer: 'conversational',
        readOnly: true,
      });
    });

    it('calls all four per-layer GETs — never a fifth "corpus" call (already unioned server-side)', async () => {
      callMemoryProxy.mockResolvedValue({ items: [] });
      await getAllUserMemories({ userId: 'user-1', token: 'tok' });
      const calledPaths = callMemoryProxy.mock.calls.map(([args]) => args.path).sort();
      expect(calledPaths).toEqual(['conversational', 'episodic', 'procedural', 'semantic']);
    });
  });

  describe('createMemory — CRUD → correct BFF endpoint/method, composite-key round trip', () => {
    it('a bare key defaults to a semantic POST in the personalization collection', async () => {
      callMemoryProxy.mockResolvedValue({ id: 'row-1' });
      const result = await createMemory({
        userId: 'u',
        key: 'timezone',
        value: 'UTC',
        token: 'tok',
      });

      expect(callMemoryProxy).toHaveBeenCalledWith({
        method: 'POST',
        path: 'semantic',
        token: 'tok',
        body: { collection: 'librechat_personalization', document_id: 'timezone', text: 'UTC' },
      });
      expect(result.ok).toBe(true);
      // Composite-key round trip: what create() returns as `key` parses back
      // to the exact target we just POSTed to.
      expect(parseCompositeKey(result.memory.key)).toEqual({
        layer: 'semantic',
        nativeRef: 'librechat_personalization/timezone',
      });
    });

    it('an explicit procedural: prefix POSTs to /memory/procedural', async () => {
      callMemoryProxy.mockResolvedValue({ id: 'row-2' });
      const result = await createMemory({
        userId: 'u',
        key: 'procedural:my-skill.md',
        value: '# skill body',
        token: 'tok',
      });

      expect(callMemoryProxy).toHaveBeenCalledWith({
        method: 'POST',
        path: 'procedural',
        token: 'tok',
        body: { filename: 'my-skill.md', content: '# skill body' },
      });
      expect(parseCompositeKey(result.memory.key)).toEqual({
        layer: 'procedural',
        nativeRef: 'my-skill.md',
      });
    });
  });

  describe('setMemory / deleteMemory — PUT/DELETE map to the right endpoint, composite-key round trip', () => {
    it('PUT targets /memory/procedural/{filename}', async () => {
      callMemoryProxy
        .mockResolvedValueOnce({ metadata: { tier: 'private' } }) // the existing-tier GET
        .mockResolvedValueOnce({ id: 'row' }); // the PUT itself

      await setMemory({
        userId: 'u',
        key: 'procedural:my-skill.md',
        value: 'new body',
        token: 'tok',
      });

      expect(callMemoryProxy).toHaveBeenNthCalledWith(2, {
        method: 'PUT',
        path: 'procedural/my-skill.md',
        token: 'tok',
        body: { content: 'new body' },
      });
    });

    it('DELETE targets /memory/semantic/{collection}/{document_id}, soft (no ?hard) by default', async () => {
      callMemoryProxy
        .mockResolvedValueOnce({ metadata: { tier: 'private' } })
        .mockResolvedValueOnce({ id: 'row' });

      await deleteMemory({
        userId: 'u',
        key: 'semantic:librechat_personalization/timezone',
        token: 'tok',
      });

      expect(callMemoryProxy).toHaveBeenNthCalledWith(2, {
        method: 'DELETE',
        path: 'semantic/librechat_personalization/timezone',
        token: 'tok',
      });
    });

    it('rejects a malformed composite key with InvalidCompositeKeyError, without any BFF call', async () => {
      await expect(
        setMemory({ userId: 'u', key: 'not-a-composite-key', value: 'x', token: 'tok' }),
      ).rejects.toThrow(InvalidCompositeKeyError);
      expect(callMemoryProxy).not.toHaveBeenCalled();
    });
  });

  describe('read-only enforcement — the falsifiable guard (M3-WU-D2-2 acceptance criterion #2)', () => {
    it('a write to episodic is REJECTED with 403 and NEVER forwarded to the BFF at all', async () => {
      await expect(
        setMemory({ userId: 'u', key: 'episodic:ADR-001.md', value: 'tampered', token: 'tok' }),
      ).rejects.toThrow(ReadOnlyLayerError);
      expect(callMemoryProxy).not.toHaveBeenCalled();
    });

    it('a delete of a conversational session is REJECTED with 403 and NEVER forwarded', async () => {
      await expect(
        deleteMemory({ userId: 'u', key: 'conversational:sess-1', token: 'tok' }),
      ).rejects.toThrow(ReadOnlyLayerError);
      expect(callMemoryProxy).not.toHaveBeenCalled();
    });

    it('a write to an EXISTING corpus-tier semantic item is REJECTED with 403 — the PUT/DELETE call never happens, only the tier-check GET', async () => {
      callMemoryProxy.mockResolvedValueOnce({ metadata: { tier: 'corpus' } });

      await expect(
        setMemory({
          userId: 'u',
          key: 'semantic:decisions_v2/shared-doc',
          value: 'edited',
          token: 'tok',
        }),
      ).rejects.toThrow(ReadOnlyLayerError);

      // Exactly the tier-check GET happened — no PUT.
      expect(callMemoryProxy).toHaveBeenCalledTimes(1);
      expect(callMemoryProxy).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'GET', path: 'semantic/decisions_v2/shared-doc' }),
      );
    });

    it('a write to a PRIVATE-tier semantic item (the common case) proceeds to the PUT', async () => {
      callMemoryProxy
        .mockResolvedValueOnce({ metadata: { tier: 'private' } })
        .mockResolvedValueOnce({});

      await setMemory({
        userId: 'u',
        key: 'semantic:librechat_personalization/timezone',
        value: 'CET',
        token: 'tok',
      });

      expect(callMemoryProxy).toHaveBeenCalledTimes(2);
      expect(callMemoryProxy).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          method: 'PUT',
          path: 'semantic/librechat_personalization/timezone',
        }),
      );
    });
  });

  describe('setMemoryById / deleteMemoryById — the composite key doubles as the opaque id', () => {
    it('setMemoryById with no explicit key uses `id` as the target', async () => {
      callMemoryProxy
        .mockResolvedValueOnce({ metadata: { tier: 'private' } })
        .mockResolvedValueOnce({});
      await setMemoryById({
        userId: 'u',
        id: 'semantic:librechat_personalization/timezone',
        value: 'PST',
        token: 'tok',
      });
      expect(callMemoryProxy).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          method: 'PUT',
          path: 'semantic/librechat_personalization/timezone',
        }),
      );
    });

    it('deleteMemoryById on a read-only id is rejected with 403, never forwarded', async () => {
      await expect(
        deleteMemoryById({ userId: 'u', id: 'episodic:ADR-001.md', token: 'tok' }),
      ).rejects.toThrow(ReadOnlyLayerError);
      expect(callMemoryProxy).not.toHaveBeenCalled();
    });
  });
});
