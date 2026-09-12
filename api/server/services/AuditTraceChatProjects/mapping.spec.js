const { isPlainObject, chatProjectUpsertBody, apiToProject } = require('./mapping');

describe('AuditTraceChatProjects/mapping — pure field mapping (no I/O)', () => {
  describe('isPlainObject', () => {
    it('true for a plain object, false for arrays/null/primitives', () => {
      expect(isPlainObject({})).toBe(true);
      expect(isPlainObject([])).toBe(false);
      expect(isPlainObject(null)).toBe(false);
      expect(isPlainObject('x')).toBe(false);
    });
  });

  describe('chatProjectUpsertBody', () => {
    it('builds the ConsoleChatProjectUpsertRequest shape', () => {
      expect(chatProjectUpsertBody('p1', { name: 'My Project', description: 'desc' })).toEqual({
        chat_project_id: 'p1',
        name: 'My Project',
        description: 'desc',
      });
    });

    it('leaves description undefined when absent/null', () => {
      expect(chatProjectUpsertBody('p1', { name: 'My Project' })).toEqual({
        chat_project_id: 'p1',
        name: 'My Project',
        description: undefined,
      });
      expect(chatProjectUpsertBody('p1', { name: 'My Project', description: null })).toEqual({
        chat_project_id: 'p1',
        name: 'My Project',
        description: undefined,
      });
    });
  });

  describe('apiToProject', () => {
    it('maps identity/timestamp fields and defaults the not-tracked stats fields', () => {
      const item = {
        chat_project_id: 'p1',
        name: 'My Project',
        description: 'desc',
        created_at_ms: 1000,
        updated_at_ms: 2000,
        metadata: {},
      };
      const result = apiToProject(item, 'user-1');
      expect(result).toEqual({
        _id: 'p1',
        name: 'My Project',
        description: 'desc',
        user: 'user-1',
        conversationCount: 0,
        lastConversationAt: null,
        lastConversationId: null,
        createdAt: new Date(1000).toISOString(),
        updatedAt: new Date(2000).toISOString(),
      });
    });

    it('the not-tracked stats fields are ALWAYS the zero-value, never sourced from the response', () => {
      // Even if a hostile/future upstream response carried these fields,
      // this adapter never trusts them — see mapping.js's docstring.
      const item = {
        chat_project_id: 'p1',
        name: 'My Project',
        description: '',
        created_at_ms: 0,
        updated_at_ms: 0,
        conversationCount: 99,
        lastConversationAt: '2026-01-01T00:00:00.000Z',
        lastConversationId: 'conv-1',
      };
      const result = apiToProject(item, 'user-1');
      expect(result.conversationCount).toBe(0);
      expect(result.lastConversationAt).toBeNull();
      expect(result.lastConversationId).toBeNull();
    });
  });
});
