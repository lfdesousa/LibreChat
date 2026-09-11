/**
 * Unit tests for the preset adapter (MongoDB-elimination WU-presets).
 * Mocks ONLY the HTTP boundary (`./client`) — `index.js`'s own logic
 * (merge-before-write, fan-out delete/list, binder arity) is REAL,
 * unmocked code.
 */
jest.mock('./client', () => ({ callConsolePresetsProxy: jest.fn() }));

const { callConsolePresetsProxy } = require('./client');
const { SovereignMemoryError } = require('../AuditTraceMemory/errors');
const {
  getPreset,
  getPresets,
  savePreset,
  deletePresets,
  SOVEREIGN_METHOD_BINDERS,
} = require('./index');

describe('AuditTracePresets — the sovereign preset adapter', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getPreset', () => {
    it('maps a found preset to the LibreChat shape', async () => {
      callConsolePresetsProxy.mockResolvedValue({
        preset_id: 'p1',
        title: 't',
        data: { endpoint: 'openAI' },
        created_at_ms: 0,
        updated_at_ms: 0,
      });
      const result = await getPreset('user-1', 'p1', 'tok');
      expect(result).toMatchObject({ presetId: 'p1', endpoint: 'openAI', user: 'user-1' });
      expect(callConsolePresetsProxy).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'GET', path: 'p1', token: 'tok' }),
      );
    });

    it('returns null on 404 (not found/not owned) — never throws', async () => {
      callConsolePresetsProxy.mockRejectedValue(new SovereignMemoryError('nope', 404));
      await expect(getPreset('user-1', 'missing', 'tok')).resolves.toBeNull();
    });

    it('propagates a non-404 error (fail-closed)', async () => {
      callConsolePresetsProxy.mockRejectedValue(new SovereignMemoryError('boom', 502));
      await expect(getPreset('user-1', 'p1', 'tok')).rejects.toMatchObject({ status: 502 });
    });
  });

  describe('getPresets', () => {
    it('pages through the full list and sorts by order asc, then updatedAt desc', async () => {
      callConsolePresetsProxy.mockResolvedValueOnce({
        items: [
          { preset_id: 'p-no-order', title: 't', data: {}, created_at_ms: 0, updated_at_ms: 100 },
          {
            preset_id: 'p-order-5',
            title: 't',
            data: { order: 5 },
            created_at_ms: 0,
            updated_at_ms: 50,
          },
        ],
        next_cursor: 'cursor-2',
      });
      callConsolePresetsProxy.mockResolvedValueOnce({
        items: [
          {
            preset_id: 'p-order-1',
            title: 't',
            data: { order: 1 },
            created_at_ms: 0,
            updated_at_ms: 10,
          },
        ],
        next_cursor: null,
      });

      const result = await getPresets('user-1', undefined, 'tok');

      expect(result.map((p) => p.presetId)).toEqual(['p-order-1', 'p-order-5', 'p-no-order']);
      expect(callConsolePresetsProxy).toHaveBeenCalledTimes(2);
      expect(callConsolePresetsProxy).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ query: expect.objectContaining({ cursor: 'cursor-2' }) }),
      );
    });

    it('breaks order ties by updatedAt descending (most recent first)', async () => {
      callConsolePresetsProxy.mockResolvedValueOnce({
        items: [
          { preset_id: 'older', title: 't', data: {}, created_at_ms: 0, updated_at_ms: 100 },
          { preset_id: 'newer', title: 't', data: {}, created_at_ms: 0, updated_at_ms: 200 },
        ],
        next_cursor: null,
      });
      const result = await getPresets('user-1', undefined, 'tok');
      expect(result.map((p) => p.presetId)).toEqual(['newer', 'older']);
    });

    it('returns an empty list when the caller has no presets', async () => {
      callConsolePresetsProxy.mockResolvedValueOnce({ items: [], next_cursor: null });
      await expect(getPresets('user-1', undefined, 'tok')).resolves.toEqual([]);
    });
  });

  describe('savePreset', () => {
    it('requires presetId — throws a 400 SovereignMemoryError, never silently no-ops', async () => {
      await expect(savePreset('user-1', {}, 'tok')).rejects.toMatchObject({ status: 400 });
      expect(callConsolePresetsProxy).not.toHaveBeenCalled();
    });

    it('creates a new preset (no existing row) — fetch-existing tolerates 404', async () => {
      callConsolePresetsProxy
        .mockRejectedValueOnce(new SovereignMemoryError('not found', 404)) // existing-fetch
        .mockResolvedValueOnce({
          preset_id: 'p1',
          title: 'My Preset',
          data: { endpoint: 'openAI' },
          created_at_ms: 0,
          updated_at_ms: 0,
        });

      const result = await savePreset(
        'user-1',
        { presetId: 'p1', title: 'My Preset', endpoint: 'openAI' },
        'tok',
      );

      expect(result).toMatchObject({ presetId: 'p1', endpoint: 'openAI' });
      expect(callConsolePresetsProxy).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          method: 'POST',
          body: { preset_id: 'p1', title: 'My Preset', data: { endpoint: 'openAI' } },
        }),
      );
    });

    it('DATA-CLOBBER GUARD: merges the caller delta onto the EXISTING data bag, never wholesale-replaces it', async () => {
      callConsolePresetsProxy
        .mockResolvedValueOnce({
          // existing-fetch
          preset_id: 'p1',
          title: 'My Preset',
          data: { endpoint: 'openAI', model: 'gpt-4', temperature: 0.7 },
          created_at_ms: 0,
          updated_at_ms: 0,
        })
        .mockResolvedValueOnce({
          preset_id: 'p1',
          title: 'My Preset',
          data: { endpoint: 'openAI', model: 'gpt-4', temperature: 0.9 },
          created_at_ms: 0,
          updated_at_ms: 1,
        });

      // A caller that only sends the changed field (temperature) — a
      // partial delta, the exact shape that would silently wipe
      // `endpoint`/`model` without the merge-before-write guard.
      await savePreset('user-1', { presetId: 'p1', temperature: 0.9 }, 'tok');

      expect(callConsolePresetsProxy).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          body: {
            preset_id: 'p1',
            title: 'My Preset',
            data: { endpoint: 'openAI', model: 'gpt-4', temperature: 0.9 },
          },
        }),
      );
    });

    it('defaultPreset === true sets defaultPreset + order:0 on THIS preset', async () => {
      callConsolePresetsProxy
        .mockRejectedValueOnce(new SovereignMemoryError('not found', 404))
        .mockResolvedValueOnce({
          preset_id: 'p1',
          title: 't',
          data: { defaultPreset: true, order: 0 },
          created_at_ms: 0,
          updated_at_ms: 0,
        });

      await savePreset('user-1', { presetId: 'p1', defaultPreset: true }, 'tok');

      expect(callConsolePresetsProxy).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          body: expect.objectContaining({ data: { defaultPreset: true, order: 0 } }),
        }),
      );
    });

    it('defaultPreset === false explicitly clears defaultPreset/order', async () => {
      callConsolePresetsProxy
        .mockResolvedValueOnce({
          preset_id: 'p1',
          title: 't',
          data: { defaultPreset: true, order: 0, endpoint: 'openAI' },
          created_at_ms: 0,
          updated_at_ms: 0,
        })
        .mockResolvedValueOnce({
          preset_id: 'p1',
          title: 't',
          data: { endpoint: 'openAI' },
          created_at_ms: 0,
          updated_at_ms: 1,
        });

      await savePreset('user-1', { presetId: 'p1', defaultPreset: false }, 'tok');

      expect(callConsolePresetsProxy).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          body: expect.objectContaining({ data: { endpoint: 'openAI' } }),
        }),
      );
    });

    it('newPresetId upserts under the NEW id (documented: old row is left behind)', async () => {
      callConsolePresetsProxy
        .mockRejectedValueOnce(new SovereignMemoryError('not found', 404)) // fetch by OLD id
        .mockResolvedValueOnce({
          preset_id: 'p2',
          title: 't',
          data: {},
          created_at_ms: 0,
          updated_at_ms: 0,
        });

      await savePreset('user-1', { presetId: 'p1', newPresetId: 'p2', title: 't' }, 'tok');

      expect(callConsolePresetsProxy).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ method: 'GET', path: 'p1' }),
      );
      expect(callConsolePresetsProxy).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ body: expect.objectContaining({ preset_id: 'p2' }) }),
      );
    });
  });

  describe('deletePresets', () => {
    it('deletes exactly the one preset named by filter.presetId', async () => {
      callConsolePresetsProxy.mockResolvedValue({});
      const result = await deletePresets('user-1', { presetId: 'p1' }, 'tok');
      expect(result).toEqual({ acknowledged: true, deletedCount: 1 });
      expect(callConsolePresetsProxy).toHaveBeenCalledTimes(1);
      expect(callConsolePresetsProxy).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'DELETE', path: 'p1' }),
      );
    });

    it('an empty/absent filter fans out to every preset the caller owns (delete-all)', async () => {
      callConsolePresetsProxy
        .mockResolvedValueOnce({
          items: [{ preset_id: 'p1' }, { preset_id: 'p2' }],
          next_cursor: null,
        })
        .mockResolvedValueOnce({}) // DELETE p1
        .mockResolvedValueOnce({}); // DELETE p2

      const result = await deletePresets('user-1', {}, 'tok');

      expect(result).toEqual({ acknowledged: true, deletedCount: 2 });
      expect(callConsolePresetsProxy).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ method: 'DELETE', path: 'p1' }),
      );
      expect(callConsolePresetsProxy).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({ method: 'DELETE', path: 'p2' }),
      );
    });

    it('tolerates a 404 per-id (already deleted) — idempotent, matches Mongo deleteMany semantics', async () => {
      callConsolePresetsProxy
        .mockResolvedValueOnce({
          items: [{ preset_id: 'p1' }, { preset_id: 'p2' }],
          next_cursor: null,
        })
        .mockRejectedValueOnce(new SovereignMemoryError('gone', 404))
        .mockResolvedValueOnce({});

      const result = await deletePresets('user-1', {}, 'tok');
      expect(result).toEqual({ acknowledged: true, deletedCount: 1 });
    });

    it('a non-404 delete error is fail-closed (propagates, stops the fan-out)', async () => {
      callConsolePresetsProxy
        .mockResolvedValueOnce({ items: [{ preset_id: 'p1' }], next_cursor: null })
        .mockRejectedValueOnce(new SovereignMemoryError('boom', 502));

      await expect(deletePresets('user-1', {}, 'tok')).rejects.toMatchObject({ status: 502 });
    });
  });

  describe('SOVEREIGN_METHOD_BINDERS — fixed positional arity, token always in the last slot', () => {
    it('names exactly the four preset methods', () => {
      expect(Object.keys(SOVEREIGN_METHOD_BINDERS).sort()).toEqual([
        'deletePresets',
        'getPreset',
        'getPresets',
        'savePreset',
      ]);
    });

    it('each binder threads the given token through to the adapter call', async () => {
      callConsolePresetsProxy.mockResolvedValue({
        preset_id: 'p1',
        title: 't',
        data: {},
        created_at_ms: 0,
        updated_at_ms: 0,
      });
      await SOVEREIGN_METHOD_BINDERS.getPreset('bound-token')('user-1', 'p1');
      expect(callConsolePresetsProxy).toHaveBeenCalledWith(
        expect.objectContaining({ token: 'bound-token' }),
      );
    });
  });
});
