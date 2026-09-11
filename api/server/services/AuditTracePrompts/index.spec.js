/**
 * Unit tests for the prompt adapter (MongoDB-elimination WU-prompts).
 * Mocks ONLY the HTTP boundary (`./client`) — `index.js`'s own logic
 * (merge-before-write, fan-out, id minting, binder arity) is REAL,
 * unmocked code.
 */
jest.mock('./client', () => ({ callConsolePromptsProxy: jest.fn() }));

const { callConsolePromptsProxy } = require('./client');
const { SovereignMemoryError } = require('../AuditTraceMemory/errors');
const {
  createPromptGroup,
  savePrompt,
  getPromptGroup,
  getPrompt,
  getPrompts,
  updatePromptGroup,
  makePromptProduction,
  deletePromptGroup,
  deleteUserPrompts,
  incrementPromptGroupUsage,
  SOVEREIGN_METHOD_BINDERS,
} = require('./index');

const OBJECT_ID_RE = /^[a-f0-9]{24}$/;

describe('AuditTracePrompts — the sovereign prompt adapter', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('createPromptGroup', () => {
    it('requires group.name and prompt.prompt — throws a 400, never silently no-ops', async () => {
      await expect(createPromptGroup({ prompt: {}, group: {} }, 'tok')).rejects.toMatchObject({
        status: 400,
      });
      await expect(
        createPromptGroup({ prompt: { prompt: 'x' }, group: {} }, 'tok'),
      ).rejects.toMatchObject({ status: 400 });
      expect(callConsolePromptsProxy).not.toHaveBeenCalled();
    });

    it('creates the group, its first version, and marks it production — mints Mongo-ObjectId-shaped ids', async () => {
      callConsolePromptsProxy
        .mockResolvedValueOnce({}) // POST group
        .mockResolvedValueOnce({
          prompt_id: 'will-be-overwritten-by-mint',
          group_id: 'g',
          text: 'hello',
          type: 'text',
          metadata: { author: 'u1' },
          created_at_ms: 0,
          updated_at_ms: 0,
        }) // POST version
        .mockResolvedValueOnce({
          group_id: 'g',
          name: 'My Group',
          category: '',
          oneliner: '',
          production_prompt_id: 'p1',
          metadata: { author: 'u1', authorName: 'User One', numberOfGenerations: 0 },
          created_at_ms: 0,
          updated_at_ms: 0,
        }); // PATCH production

      const result = await createPromptGroup(
        {
          prompt: { prompt: 'hello', type: 'text' },
          group: { name: 'My Group' },
          author: 'u1',
          authorName: 'User One',
        },
        'tok',
      );

      expect(result.prompt.prompt).toBe('hello');
      expect(result.group).toMatchObject({
        name: 'My Group',
        productionPrompt: { prompt: 'hello' },
      });

      // Step 1: create the group with a minted, ObjectId-shaped id.
      const groupCall = callConsolePromptsProxy.mock.calls[0][0];
      expect(groupCall.method).toBe('POST');
      expect(groupCall.path).toBe('');
      expect(groupCall.body.group_id).toMatch(OBJECT_ID_RE);
      expect(groupCall.body.metadata).toEqual({
        author: 'u1',
        authorName: 'User One',
        numberOfGenerations: 0,
      });

      // Step 2: create the first version under that SAME group id.
      const versionCall = callConsolePromptsProxy.mock.calls[1][0];
      expect(versionCall.method).toBe('POST');
      expect(versionCall.path).toBe(`${groupCall.body.group_id}/versions`);
      expect(versionCall.body.prompt_id).toMatch(OBJECT_ID_RE);
      expect(versionCall.body.text).toBe('hello');

      // Step 3: mark that version production.
      const productionCall = callConsolePromptsProxy.mock.calls[2][0];
      expect(productionCall.method).toBe('PATCH');
      expect(productionCall.path).toBe(`${groupCall.body.group_id}/production`);
      expect(productionCall.body.prompt_id).toBe(versionCall.body.prompt_id);
    });
  });

  describe('savePrompt', () => {
    it('requires prompt.groupId and prompt.prompt — throws a 400, never silently no-ops', async () => {
      await expect(savePrompt({ prompt: {} }, 'tok')).rejects.toMatchObject({ status: 400 });
      await expect(savePrompt({ prompt: { groupId: 'g1' } }, 'tok')).rejects.toMatchObject({
        status: 400,
      });
      expect(callConsolePromptsProxy).not.toHaveBeenCalled();
    });

    it('always mints a FRESH promptId — sidesteps the upsert_version group-reassign quirk by construction', async () => {
      callConsolePromptsProxy.mockResolvedValue({
        prompt_id: 'ignored',
        group_id: 'g1',
        text: 'v1',
        type: 'text',
        metadata: {},
        created_at_ms: 0,
        updated_at_ms: 0,
      });

      await savePrompt({ prompt: { groupId: 'g1', prompt: 'v1', type: 'text' } }, 'tok');
      await savePrompt({ prompt: { groupId: 'g1', prompt: 'v2', type: 'text' } }, 'tok');

      const firstId = callConsolePromptsProxy.mock.calls[0][0].body.prompt_id;
      const secondId = callConsolePromptsProxy.mock.calls[1][0].body.prompt_id;
      expect(firstId).toMatch(OBJECT_ID_RE);
      expect(secondId).toMatch(OBJECT_ID_RE);
      expect(firstId).not.toBe(secondId);
      expect(callConsolePromptsProxy.mock.calls[0][0].path).toBe('g1/versions');
    });

    it('a non-2xx backend failure propagates — does NOT swallow to a Mongo-style {message} 200', async () => {
      callConsolePromptsProxy.mockRejectedValue(new SovereignMemoryError('not owned', 404));
      await expect(
        savePrompt({ prompt: { groupId: 'g1', prompt: 'x', type: 'text' } }, 'tok'),
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('getPromptGroup', () => {
    it('maps a found group + resolves productionPrompt from its versions', async () => {
      callConsolePromptsProxy.mockResolvedValue({
        group_id: 'g1',
        name: 'My Group',
        category: '',
        oneliner: '',
        production_prompt_id: 'p2',
        metadata: {},
        created_at_ms: 0,
        updated_at_ms: 0,
        versions: [
          {
            prompt_id: 'p1',
            group_id: 'g1',
            text: 'v1',
            type: 'text',
            metadata: {},
            created_at_ms: 0,
            updated_at_ms: 0,
          },
          {
            prompt_id: 'p2',
            group_id: 'g1',
            text: 'v2',
            type: 'text',
            metadata: {},
            created_at_ms: 0,
            updated_at_ms: 0,
          },
        ],
      });
      const result = await getPromptGroup({ _id: 'g1' }, 'tok');
      expect(result._id).toBe('g1');
      expect(result.productionPrompt).toEqual({ prompt: 'v2' });
      expect(callConsolePromptsProxy).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'GET', path: 'g1', token: 'tok' }),
      );
    });

    it('productionPrompt is null when no version matches production_prompt_id', async () => {
      callConsolePromptsProxy.mockResolvedValue({
        group_id: 'g1',
        name: 'n',
        category: '',
        oneliner: '',
        production_prompt_id: null,
        metadata: {},
        created_at_ms: 0,
        updated_at_ms: 0,
        versions: [],
      });
      const result = await getPromptGroup({ _id: 'g1' }, 'tok');
      expect(result.productionPrompt).toBeNull();
    });

    it('returns null on 404 (not found/not owned) — never throws', async () => {
      callConsolePromptsProxy.mockRejectedValue(new SovereignMemoryError('nope', 404));
      await expect(getPromptGroup({ _id: 'missing' }, 'tok')).resolves.toBeNull();
    });

    it('returns null for a malformed/missing filter without calling the backend', async () => {
      await expect(getPromptGroup({}, 'tok')).resolves.toBeNull();
      expect(callConsolePromptsProxy).not.toHaveBeenCalled();
    });

    it('propagates a non-404 error (fail-closed)', async () => {
      callConsolePromptsProxy.mockRejectedValue(new SovereignMemoryError('boom', 502));
      await expect(getPromptGroup({ _id: 'g1' }, 'tok')).rejects.toMatchObject({ status: 502 });
    });
  });

  describe('getPrompt', () => {
    it('with an explicit groupId, fetches that group directly and finds the version', async () => {
      callConsolePromptsProxy.mockResolvedValue({
        group_id: 'g1',
        versions: [
          {
            prompt_id: 'p1',
            group_id: 'g1',
            text: 'v1',
            type: 'text',
            metadata: {},
            created_at_ms: 0,
            updated_at_ms: 0,
          },
        ],
      });
      const result = await getPrompt({ _id: 'p1', groupId: 'g1' }, 'tok');
      expect(result).toMatchObject({ _id: 'p1', prompt: 'v1' });
      expect(callConsolePromptsProxy).toHaveBeenCalledTimes(1);
      expect(callConsolePromptsProxy).toHaveBeenCalledWith(expect.objectContaining({ path: 'g1' }));
    });

    it('with NO groupId (the real-world route/middleware shape), scans every owned group', async () => {
      callConsolePromptsProxy
        .mockResolvedValueOnce({
          items: [{ group_id: 'g1' }, { group_id: 'g2' }],
          next_cursor: null,
        })
        .mockResolvedValueOnce({ group_id: 'g1', versions: [] })
        .mockResolvedValueOnce({
          group_id: 'g2',
          versions: [
            {
              prompt_id: 'p9',
              group_id: 'g2',
              text: 'found',
              type: 'text',
              metadata: {},
              created_at_ms: 0,
              updated_at_ms: 0,
            },
          ],
        });

      const result = await getPrompt({ _id: 'p9' }, 'tok');
      expect(result).toMatchObject({ _id: 'p9', prompt: 'found', groupId: 'g2' });
    });

    it('returns null when no owned group has a matching version', async () => {
      callConsolePromptsProxy.mockResolvedValueOnce({ items: [], next_cursor: null });
      await expect(getPrompt({ _id: 'nope' }, 'tok')).resolves.toBeNull();
    });

    it('returns null for a malformed/missing filter without calling the backend', async () => {
      await expect(getPrompt({}, 'tok')).resolves.toBeNull();
      expect(callConsolePromptsProxy).not.toHaveBeenCalled();
    });
  });

  describe('getPrompts', () => {
    it('with a groupId, returns every version in that ONE group', async () => {
      callConsolePromptsProxy.mockResolvedValue({
        group_id: 'g1',
        versions: [
          {
            prompt_id: 'p1',
            group_id: 'g1',
            text: 'v1',
            type: 'text',
            metadata: {},
            created_at_ms: 0,
            updated_at_ms: 0,
          },
          {
            prompt_id: 'p2',
            group_id: 'g1',
            text: 'v2',
            type: 'text',
            metadata: {},
            created_at_ms: 0,
            updated_at_ms: 0,
          },
        ],
      });
      const result = await getPrompts({ groupId: 'g1' }, 'tok');
      expect(result.map((p) => p._id)).toEqual(['p1', 'p2']);
    });

    it('accepts a groupId as a stringifiable object (mongodb.ObjectId shape)', async () => {
      callConsolePromptsProxy.mockResolvedValue({ group_id: 'g1', versions: [] });
      const objectIdLike = { toString: () => 'g1' };
      await getPrompts({ groupId: objectIdLike }, 'tok');
      expect(callConsolePromptsProxy).toHaveBeenCalledWith(expect.objectContaining({ path: 'g1' }));
    });

    it("with no groupId, flattens every owned group's versions, newest-first", async () => {
      callConsolePromptsProxy
        .mockResolvedValueOnce({
          items: [{ group_id: 'g1' }, { group_id: 'g2' }],
          next_cursor: null,
        })
        .mockResolvedValueOnce({
          group_id: 'g1',
          versions: [
            {
              prompt_id: 'older',
              group_id: 'g1',
              text: 'older',
              type: 'text',
              metadata: {},
              created_at_ms: 100,
              updated_at_ms: 100,
            },
          ],
        })
        .mockResolvedValueOnce({
          group_id: 'g2',
          versions: [
            {
              prompt_id: 'newer',
              group_id: 'g2',
              text: 'newer',
              type: 'text',
              metadata: {},
              created_at_ms: 200,
              updated_at_ms: 200,
            },
          ],
        });

      const result = await getPrompts({ author: 'u1' }, 'tok');
      expect(result.map((p) => p._id)).toEqual(['newer', 'older']);
    });
  });

  describe('updatePromptGroup', () => {
    it('merges the caller delta onto the existing row, always re-sending the EXISTING metadata bag unchanged', async () => {
      callConsolePromptsProxy
        .mockResolvedValueOnce({
          group_id: 'g1',
          name: 'Old Name',
          category: 'old-cat',
          oneliner: 'old-one',
          command: 'oldcmd',
          metadata: { author: 'u1', authorName: 'User One', numberOfGenerations: 5 },
          created_at_ms: 0,
          updated_at_ms: 0,
        })
        .mockResolvedValueOnce({
          group_id: 'g1',
          name: 'New Name',
          category: 'old-cat',
          oneliner: 'old-one',
          command: 'oldcmd',
          metadata: { author: 'u1', authorName: 'User One', numberOfGenerations: 5 },
          created_at_ms: 0,
          updated_at_ms: 1,
        });

      await updatePromptGroup({ _id: 'g1' }, { name: 'New Name' }, 'tok');

      const upsertCall = callConsolePromptsProxy.mock.calls[1][0];
      expect(upsertCall.body).toEqual({
        group_id: 'g1',
        name: 'New Name',
        category: 'old-cat',
        oneliner: 'old-one',
        command: 'oldcmd',
        // DATA-CLOBBER GUARD: the existing metadata bag (author/
        // authorName/numberOfGenerations) is preserved verbatim even
        // though `data` never mentioned it.
        metadata: { author: 'u1', authorName: 'User One', numberOfGenerations: 5 },
      });
    });

    it('returns the Mongo-matching {message} shape when the group does not exist/is not owned', async () => {
      callConsolePromptsProxy.mockRejectedValue(new SovereignMemoryError('nope', 404));
      await expect(updatePromptGroup({ _id: 'missing' }, { name: 'x' }, 'tok')).resolves.toEqual({
        message: 'Error updating prompt group',
      });
    });

    it('returns the same {message} shape for a malformed/missing filter, without calling the backend', async () => {
      await expect(updatePromptGroup({}, { name: 'x' }, 'tok')).resolves.toEqual({
        message: 'Error updating prompt group',
      });
      expect(callConsolePromptsProxy).not.toHaveBeenCalled();
    });
  });

  describe('makePromptProduction', () => {
    it('resolves the owning group then PATCHes production', async () => {
      callConsolePromptsProxy
        .mockResolvedValueOnce({ items: [{ group_id: 'g1' }], next_cursor: null })
        .mockResolvedValueOnce({
          group_id: 'g1',
          versions: [
            {
              prompt_id: 'p1',
              group_id: 'g1',
              text: 'v1',
              type: 'text',
              metadata: {},
              created_at_ms: 0,
              updated_at_ms: 0,
            },
          ],
        })
        .mockResolvedValueOnce({});

      const result = await makePromptProduction('p1', 'tok');
      expect(result).toEqual({ message: 'Prompt production made successfully' });
      expect(callConsolePromptsProxy).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({
          method: 'PATCH',
          path: 'g1/production',
          body: { prompt_id: 'p1' },
        }),
      );
    });

    it('returns the Mongo-matching {message} shape when the version is not found/not owned', async () => {
      callConsolePromptsProxy.mockResolvedValueOnce({ items: [], next_cursor: null });
      await expect(makePromptProduction('missing', 'tok')).resolves.toEqual({
        message: 'Error making prompt production',
      });
    });
  });

  describe('deletePromptGroup', () => {
    it('deletes the named group', async () => {
      callConsolePromptsProxy.mockResolvedValue({});
      const result = await deletePromptGroup({ _id: 'g1' }, 'tok');
      expect(result).toEqual({ message: 'Prompt group deleted successfully' });
      expect(callConsolePromptsProxy).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'DELETE', path: 'g1' }),
      );
    });

    it('throws a PLAIN Error("Prompt group not found") on 404 — mirrors Mongo\'s own unconditional throw', async () => {
      callConsolePromptsProxy.mockRejectedValue(new SovereignMemoryError('nope', 404));
      await expect(deletePromptGroup({ _id: 'missing' }, 'tok')).rejects.toThrow(
        'Prompt group not found',
      );
    });

    it('requires _id — throws a 400, never silently no-ops', async () => {
      await expect(deletePromptGroup({}, 'tok')).rejects.toMatchObject({ status: 400 });
      expect(callConsolePromptsProxy).not.toHaveBeenCalled();
    });
  });

  describe('deleteUserPrompts', () => {
    it('fans out to delete every group the caller owns', async () => {
      callConsolePromptsProxy
        .mockResolvedValueOnce({
          items: [{ group_id: 'g1' }, { group_id: 'g2' }],
          next_cursor: null,
        })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      await deleteUserPrompts('u1', 'tok');

      expect(callConsolePromptsProxy).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ method: 'DELETE', path: 'g1' }),
      );
      expect(callConsolePromptsProxy).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({ method: 'DELETE', path: 'g2' }),
      );
    });

    it('tolerates a 404 per-group (already deleted) — idempotent', async () => {
      callConsolePromptsProxy
        .mockResolvedValueOnce({ items: [{ group_id: 'g1' }], next_cursor: null })
        .mockRejectedValueOnce(new SovereignMemoryError('gone', 404));
      await expect(deleteUserPrompts('u1', 'tok')).resolves.toBeUndefined();
    });

    it('a non-404 delete error is fail-closed (propagates, stops the fan-out)', async () => {
      callConsolePromptsProxy
        .mockResolvedValueOnce({ items: [{ group_id: 'g1' }], next_cursor: null })
        .mockRejectedValueOnce(new SovereignMemoryError('boom', 502));
      await expect(deleteUserPrompts('u1', 'tok')).rejects.toMatchObject({ status: 502 });
    });
  });

  describe('incrementPromptGroupUsage', () => {
    it('reads the existing count from metadata, increments, and re-upserts the WHOLE group unchanged otherwise', async () => {
      callConsolePromptsProxy
        .mockResolvedValueOnce({
          group_id: 'g1',
          name: 'My Group',
          category: 'cat',
          oneliner: 'one',
          command: 'cmd',
          metadata: { author: 'u1', numberOfGenerations: 4 },
          created_at_ms: 0,
          updated_at_ms: 0,
        })
        .mockResolvedValueOnce({});

      const result = await incrementPromptGroupUsage('g1', 'tok');
      expect(result).toEqual({ numberOfGenerations: 5 });
      expect(callConsolePromptsProxy).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          body: expect.objectContaining({
            name: 'My Group',
            category: 'cat',
            oneliner: 'one',
            command: 'cmd',
            metadata: { author: 'u1', numberOfGenerations: 5 },
          }),
        }),
      );
    });

    it('defaults to 0 -> 1 when metadata has no prior count', async () => {
      callConsolePromptsProxy
        .mockResolvedValueOnce({
          group_id: 'g1',
          name: 'n',
          category: '',
          oneliner: '',
          metadata: {},
          created_at_ms: 0,
          updated_at_ms: 0,
        })
        .mockResolvedValueOnce({});
      const result = await incrementPromptGroupUsage('g1', 'tok');
      expect(result).toEqual({ numberOfGenerations: 1 });
    });

    it('throws SovereignMemoryError("Prompt group not found", 404) when missing — matches the route\'s string check', async () => {
      callConsolePromptsProxy.mockRejectedValue(new SovereignMemoryError('nope', 404));
      await expect(incrementPromptGroupUsage('missing', 'tok')).rejects.toMatchObject({
        status: 404,
        message: 'Prompt group not found',
      });
    });
  });

  describe('SOVEREIGN_METHOD_BINDERS — fixed positional arity, token always threaded through', () => {
    it('names exactly the ten wired prompt methods', () => {
      expect(Object.keys(SOVEREIGN_METHOD_BINDERS).sort()).toEqual(
        [
          'createPromptGroup',
          'deletePromptGroup',
          'deleteUserPrompts',
          'getPrompt',
          'getPromptGroup',
          'getPrompts',
          'incrementPromptGroupUsage',
          'makePromptProduction',
          'savePrompt',
          'updatePromptGroup',
        ].sort(),
      );
    });

    it('each binder threads the given token through to the adapter call', async () => {
      callConsolePromptsProxy.mockResolvedValue({
        group_id: 'g1',
        name: 'n',
        category: '',
        oneliner: '',
        metadata: {},
        created_at_ms: 0,
        updated_at_ms: 0,
      });
      await SOVEREIGN_METHOD_BINDERS.getPromptGroup('bound-token')({ _id: 'g1' });
      expect(callConsolePromptsProxy).toHaveBeenCalledWith(
        expect.objectContaining({ token: 'bound-token' }),
      );
    });

    it('the updatePromptGroup binder passes BOTH filter and data through in order', async () => {
      callConsolePromptsProxy.mockResolvedValueOnce(null);
      const result = await SOVEREIGN_METHOD_BINDERS.updatePromptGroup('tok')(
        { _id: 'g1' },
        { name: 'x' },
      );
      expect(result).toEqual({ message: 'Error updating prompt group' });
    });
  });
});
