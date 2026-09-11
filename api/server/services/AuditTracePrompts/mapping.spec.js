const {
  isPlainObject,
  groupUpsertBody,
  versionUpsertBody,
  apiToGroup,
  apiToVersion,
} = require('./mapping');

describe('AuditTracePrompts/mapping — pure field mapping (no I/O)', () => {
  describe('isPlainObject', () => {
    it('true for a plain object, false for arrays/null/primitives', () => {
      expect(isPlainObject({})).toBe(true);
      expect(isPlainObject([])).toBe(false);
      expect(isPlainObject(null)).toBe(false);
      expect(isPlainObject('x')).toBe(false);
    });
  });

  describe('groupUpsertBody', () => {
    it('builds the ConsolePromptGroupUpsertRequest shape', () => {
      expect(
        groupUpsertBody('g1', {
          name: 'My Group',
          category: 'writing',
          oneliner: 'A oneliner',
          command: 'mycmd',
          metadata: { author: 'u1' },
        }),
      ).toEqual({
        group_id: 'g1',
        name: 'My Group',
        category: 'writing',
        oneliner: 'A oneliner',
        command: 'mycmd',
        metadata: { author: 'u1' },
      });
    });

    it('defaults metadata to {} when absent (caller must pass the merged bag explicitly)', () => {
      expect(groupUpsertBody('g1', { name: 'n' })).toEqual({
        group_id: 'g1',
        name: 'n',
        category: undefined,
        oneliner: undefined,
        command: undefined,
        metadata: {},
      });
    });

    it('coalesces null category/oneliner/command to undefined (JSON-serializable "omit")', () => {
      expect(
        groupUpsertBody('g1', { name: 'n', category: null, oneliner: null, command: null }),
      ).toMatchObject({ category: undefined, oneliner: undefined, command: undefined });
    });
  });

  describe('versionUpsertBody', () => {
    it('builds the ConsolePromptVersionUpsertRequest shape', () => {
      expect(versionUpsertBody('p1', { text: 'hello', type: 'chat', metadata: {} })).toEqual({
        prompt_id: 'p1',
        text: 'hello',
        type: 'chat',
        metadata: {},
      });
    });

    it('defaults type to "text" for anything other than the literal "chat"', () => {
      expect(versionUpsertBody('p1', { text: 'x', type: undefined })).toMatchObject({
        type: 'text',
      });
      expect(versionUpsertBody('p1', { text: 'x', type: 'bogus' })).toMatchObject({
        type: 'text',
      });
    });

    it('defaults metadata to {} when absent', () => {
      expect(versionUpsertBody('p1', { text: 'x' })).toEqual({
        prompt_id: 'p1',
        text: 'x',
        type: 'text',
        metadata: {},
      });
    });
  });

  describe('apiToGroup', () => {
    it('maps first-class columns and pulls author/authorName/numberOfGenerations out of metadata', () => {
      const item = {
        group_id: 'g1',
        name: 'My Group',
        category: 'writing',
        oneliner: 'A oneliner',
        command: 'mycmd',
        production_prompt_id: 'p1',
        metadata: { author: 'u1', authorName: 'User One', numberOfGenerations: 3 },
        created_at_ms: 1000,
        updated_at_ms: 2000,
      };
      const result = apiToGroup(item);
      expect(result).toMatchObject({
        _id: 'g1',
        name: 'My Group',
        category: 'writing',
        oneliner: 'A oneliner',
        command: 'mycmd',
        productionId: 'p1',
        author: 'u1',
        authorName: 'User One',
        numberOfGenerations: 3,
      });
      expect(result.createdAt).toBe(new Date(1000).toISOString());
      expect(result.updatedAt).toBe(new Date(2000).toISOString());
    });

    it('defaults numberOfGenerations to 0 and productionId to null when absent', () => {
      const result = apiToGroup({
        group_id: 'g1',
        name: 'n',
        category: '',
        oneliner: '',
        metadata: {},
        created_at_ms: 0,
        updated_at_ms: 0,
      });
      expect(result.numberOfGenerations).toBe(0);
      expect(result.productionId).toBeNull();
    });

    it('tolerates a non-object metadata (defensive)', () => {
      const result = apiToGroup({
        group_id: 'g1',
        name: 'n',
        category: '',
        oneliner: '',
        metadata: null,
        created_at_ms: 0,
        updated_at_ms: 0,
      });
      expect(result._id).toBe('g1');
      expect(result.numberOfGenerations).toBe(0);
    });
  });

  describe('apiToVersion', () => {
    it('maps first-class columns and pulls author out of metadata', () => {
      const item = {
        prompt_id: 'p1',
        group_id: 'g1',
        text: 'hello world',
        type: 'chat',
        metadata: { author: 'u1' },
        created_at_ms: 1000,
        updated_at_ms: 2000,
      };
      const result = apiToVersion(item);
      expect(result).toMatchObject({
        _id: 'p1',
        groupId: 'g1',
        author: 'u1',
        prompt: 'hello world',
        type: 'chat',
      });
      expect(result.createdAt).toBe(new Date(1000).toISOString());
      expect(result.updatedAt).toBe(new Date(2000).toISOString());
    });

    it('tolerates a non-object metadata (defensive)', () => {
      const result = apiToVersion({
        prompt_id: 'p1',
        group_id: 'g1',
        text: 'x',
        type: 'text',
        metadata: undefined,
        created_at_ms: 0,
        updated_at_ms: 0,
      });
      expect(result._id).toBe('p1');
      expect(result.author).toBeUndefined();
    });
  });
});
