const { isPlainObject, presetDataFields, presetUpsertBody, apiToPreset } = require('./mapping');

describe('AuditTracePresets/mapping — pure field mapping (no I/O)', () => {
  describe('isPlainObject', () => {
    it('true for a plain object, false for arrays/null/primitives', () => {
      expect(isPlainObject({})).toBe(true);
      expect(isPlainObject([])).toBe(false);
      expect(isPlainObject(null)).toBe(false);
      expect(isPlainObject('x')).toBe(false);
    });
  });

  describe('presetDataFields', () => {
    it('strips title/user/_id/__v/tenantId/createdAt/updatedAt, keeps everything else', () => {
      const rest = {
        title: 'My Preset',
        user: 'u1',
        _id: 'mongo-oid',
        __v: 0,
        tenantId: 't1',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-02',
        endpoint: 'openAI',
        model: 'gpt-4',
        temperature: 0.7,
        tools: ['web-search'],
      };
      expect(presetDataFields(rest)).toEqual({
        endpoint: 'openAI',
        model: 'gpt-4',
        temperature: 0.7,
        tools: ['web-search'],
      });
    });

    it('drops undefined-valued keys (never persists an explicit undefined)', () => {
      expect(presetDataFields({ endpoint: 'openAI', model: undefined })).toEqual({
        endpoint: 'openAI',
      });
    });

    it('handles a missing/undefined rest object', () => {
      expect(presetDataFields(undefined)).toEqual({});
    });
  });

  describe('presetUpsertBody', () => {
    it('builds the ConsolePresetUpsertRequest shape', () => {
      expect(presetUpsertBody('p1', 'My Preset', { endpoint: 'openAI' })).toEqual({
        preset_id: 'p1',
        title: 'My Preset',
        data: { endpoint: 'openAI' },
      });
    });

    it('defaults title to "New Chat" when absent/empty (mirrors the Mongo schema default)', () => {
      expect(presetUpsertBody('p1', undefined, {})).toMatchObject({ title: 'New Chat' });
      expect(presetUpsertBody('p1', '', {})).toMatchObject({ title: 'New Chat' });
    });

    it('defaults data to {} when absent', () => {
      expect(presetUpsertBody('p1', 't', undefined)).toEqual({
        preset_id: 'p1',
        title: 't',
        data: {},
      });
    });
  });

  describe('apiToPreset', () => {
    it('spreads data onto the LibreChat-shaped object and stamps identity/timestamp fields', () => {
      const item = {
        preset_id: 'p1',
        title: 'My Preset',
        data: { endpoint: 'openAI', model: 'gpt-4', order: 3 },
        created_at_ms: 1000,
        updated_at_ms: 2000,
      };
      const result = apiToPreset(item, 'user-1');
      expect(result).toMatchObject({
        presetId: 'p1',
        title: 'My Preset',
        user: 'user-1',
        endpoint: 'openAI',
        model: 'gpt-4',
        order: 3,
      });
      expect(result.createdAt).toBe(new Date(1000).toISOString());
      expect(result.updatedAt).toBe(new Date(2000).toISOString());
    });

    it('tolerates a non-object `data` (defensive)', () => {
      const result = apiToPreset(
        { preset_id: 'p1', title: 't', data: null, created_at_ms: 0, updated_at_ms: 0 },
        'u1',
      );
      expect(result.presetId).toBe('p1');
    });

    it('identity/timestamp fields ALWAYS win over a stale copy inside data (full-replace safety)', () => {
      const item = {
        preset_id: 'p1',
        title: 'Canonical Title',
        data: { presetId: 'STALE', title: 'Stale Title', user: 'stale-user' },
        created_at_ms: 0,
        updated_at_ms: 0,
      };
      const result = apiToPreset(item, 'real-user');
      expect(result.presetId).toBe('p1');
      expect(result.title).toBe('Canonical Title');
      expect(result.user).toBe('real-user');
    });
  });
});
