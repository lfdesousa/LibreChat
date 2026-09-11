const { convoUpsertBody, apiToConvo, messageUpsertBody, apiToMessage } = require('./mapping');

describe('AuditTraceConversations/mapping — LibreChat <-> /console/conversations shapes', () => {
  describe('convoUpsertBody', () => {
    it('maps the core fields and defaults is_temporary/metadata', () => {
      const body = convoUpsertBody(
        {},
        { conversationId: 'c1', title: 'Hello', endpoint: 'openAI' },
      );
      expect(body).toEqual({
        conversation_id: 'c1',
        title: 'Hello',
        endpoint: 'openAI',
        is_temporary: false,
        metadata: {},
      });
    });

    it('carries ctx.isTemporary and agent_id/chatProjectId through', () => {
      const body = convoUpsertBody(
        { isTemporary: true },
        { conversationId: 'c1', agent_id: 'agent-1', chatProjectId: 'proj-1', model: 'gpt' },
      );
      expect(body).toMatchObject({
        conversation_id: 'c1',
        is_temporary: true,
        agent_id: 'agent-1',
        chat_project_id: 'proj-1',
        model: 'gpt',
      });
    });

    it('stuffs isArchived/pinned/tags into the metadata bag (no first-class column)', () => {
      const body = convoUpsertBody(
        {},
        { conversationId: 'c1', isArchived: true, pinned: true, tags: ['a', 'b'] },
      );
      expect(body.metadata).toEqual({ isArchived: true, pinned: true, tags: ['a', 'b'] });
    });
  });

  describe('apiToConvo', () => {
    it('maps a full item, restoring isArchived/pinned/tags from metadata', () => {
      const convo = apiToConvo(
        {
          conversation_id: 'c1',
          title: 'Hello',
          endpoint: 'openAI',
          model: 'gpt-4',
          is_temporary: true,
          agent_id: 'agent-1',
          chat_project_id: 'proj-1',
          created_at_ms: Date.parse('2026-09-11T00:00:00.000Z'),
          updated_at_ms: Date.parse('2026-09-11T01:00:00.000Z'),
          metadata: { isArchived: true, pinned: false, tags: ['x'] },
        },
        'user-1',
      );
      expect(convo).toEqual({
        conversationId: 'c1',
        title: 'Hello',
        endpoint: 'openAI',
        model: 'gpt-4',
        isTemporary: true,
        agent_id: 'agent-1',
        chatProjectId: 'proj-1',
        user: 'user-1',
        createdAt: '2026-09-11T00:00:00.000Z',
        updatedAt: '2026-09-11T01:00:00.000Z',
        isArchived: true,
        pinned: false,
        tags: ['x'],
      });
    });

    it('omits isArchived/pinned/tags when the metadata bag is empty/absent', () => {
      const convo = apiToConvo({
        conversation_id: 'c1',
        title: 'Hello',
        created_at_ms: 0,
        updated_at_ms: 0,
      });
      expect(convo).not.toHaveProperty('isArchived');
      expect(convo).not.toHaveProperty('pinned');
      expect(convo).not.toHaveProperty('tags');
    });
  });

  describe('messageUpsertBody', () => {
    it('maps the core fields and defaults sender from isCreatedByUser', () => {
      const body = messageUpsertBody({ messageId: 'm1', isCreatedByUser: true, text: 'hi' });
      expect(body).toMatchObject({
        message_id: 'm1',
        sender: 'User',
        text: 'hi',
        is_created_by_user: true,
      });
    });

    it('defaults sender to AI for a non-user message', () => {
      const body = messageUpsertBody({ messageId: 'm1', isCreatedByUser: false });
      expect(body.sender).toBe('AI');
    });

    it('omits parent_message_id when null/undefined, includes it otherwise', () => {
      expect(messageUpsertBody({ messageId: 'm1', parentMessageId: null })).not.toHaveProperty(
        'parent_message_id',
      );
      expect(messageUpsertBody({ messageId: 'm1', parentMessageId: 'm0' }).parent_message_id).toBe(
        'm0',
      );
    });

    it('round-trips a boolean error flag as the string "true" (lossy v1 simplification)', () => {
      expect(messageUpsertBody({ messageId: 'm1', error: true }).error).toBe('true');
      expect(messageUpsertBody({ messageId: 'm1', error: false })).not.toHaveProperty('error');
    });
  });

  describe('apiToMessage', () => {
    it('maps a full item', () => {
      const message = apiToMessage(
        {
          message_id: 'm1',
          conversation_id: 'c1',
          parent_message_id: 'm0',
          sender: 'User',
          text: 'hi',
          is_created_by_user: true,
          model: 'gpt-4',
          endpoint: 'openAI',
          token_count: 3,
          error: 'true',
          created_at_ms: Date.parse('2026-09-11T00:00:00.000Z'),
        },
        'user-1',
      );
      expect(message).toEqual({
        messageId: 'm1',
        conversationId: 'c1',
        parentMessageId: 'm0',
        sender: 'User',
        text: 'hi',
        isCreatedByUser: true,
        model: 'gpt-4',
        endpoint: 'openAI',
        tokenCount: 3,
        error: true,
        user: 'user-1',
        createdAt: '2026-09-11T00:00:00.000Z',
      });
    });

    it('defaults parentMessageId to null when absent', () => {
      const message = apiToMessage({
        message_id: 'm1',
        conversation_id: 'c1',
        sender: 'AI',
        text: '',
        is_created_by_user: false,
        created_at_ms: 0,
      });
      expect(message.parentMessageId).toBeNull();
      expect(message.error).toBe(false);
    });
  });
});
