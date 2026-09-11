jest.mock('./client', () => ({ callConsoleConversationsProxy: jest.fn() }));

const { callConsoleConversationsProxy } = require('./client');
const {
  saveConvo,
  getConvosByCursor,
  getConvo,
  setConvoPinned,
  deleteConvos,
  saveMessage,
  updateMessage,
  getMessages,
  getMessagesByCursor,
  getMessage,
  deleteMessages,
  bulkSaveConvos,
  bulkSaveMessages,
  wrapModelMethods,
} = require('./index');
const { SovereignMemoryError, MissingAccessTokenError } = require('../AuditTraceMemory/errors');
const { runWithRequestAccessToken } = require('./requestContext');

const ORIGINAL_BACKEND = process.env.AUDITTRACE_MEMORY_BACKEND;

afterEach(() => {
  callConsoleConversationsProxy.mockReset();
  if (ORIGINAL_BACKEND === undefined) {
    delete process.env.AUDITTRACE_MEMORY_BACKEND;
  } else {
    process.env.AUDITTRACE_MEMORY_BACKEND = ORIGINAL_BACKEND;
  }
});

const CONVO_ITEM = {
  conversation_id: 'c1',
  title: 'Hello',
  is_temporary: false,
  created_at_ms: 0,
  updated_at_ms: 0,
  metadata: {},
};

const MESSAGE_ITEM = {
  message_id: 'm1',
  conversation_id: 'c1',
  sender: 'User',
  text: 'hi',
  is_created_by_user: true,
  created_at_ms: 0,
};

/** A 404 the mocked HTTP boundary raises for the "existing row" pre-fetch
 *  `saveConvo`/`updateMessage` do — the common "brand-new row" case. */
const NOT_FOUND = new SovereignMemoryError('not found', 404);

describe('AuditTraceConversations adapter (MongoDB-elimination WU-2)', () => {
  describe('saveConvo', () => {
    it('POSTs the mapped body and returns the mapped item (new conversation — existing-fetch 404s)', async () => {
      callConsoleConversationsProxy
        .mockRejectedValueOnce(NOT_FOUND) // existing-fetch GET
        .mockResolvedValueOnce(CONVO_ITEM); // the POST
      const result = await saveConvo(
        { userId: 'u1' },
        { conversationId: 'c1', title: 'Hello' },
        {},
        'tok',
      );
      expect(callConsoleConversationsProxy).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ method: 'GET', path: 'c1', token: 'tok' }),
      );
      expect(callConsoleConversationsProxy).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          method: 'POST',
          path: '',
          token: 'tok',
          body: expect.objectContaining({
            conversation_id: 'c1',
            title: 'Hello',
            is_temporary: false,
          }),
        }),
      );
      expect(result.conversationId).toBe('c1');
      expect(result.user).toBe('u1');
    });

    it('never reaches the BFF without a conversationId — 400 locally', async () => {
      await expect(saveConvo({}, {}, {}, 'tok')).rejects.toMatchObject({ status: 400 });
      expect(callConsoleConversationsProxy).not.toHaveBeenCalled();
    });

    it('fails closed on a non-2xx from the existing-fetch — the error propagates, never a Mongo fallback', async () => {
      callConsoleConversationsProxy.mockRejectedValueOnce(new SovereignMemoryError('nope', 403));
      await expect(saveConvo({}, { conversationId: 'c1' }, {}, 'tok')).rejects.toMatchObject({
        status: 403,
      });
    });

    it('fails closed on a non-2xx from the upsert itself', async () => {
      callConsoleConversationsProxy
        .mockRejectedValueOnce(NOT_FOUND)
        .mockRejectedValueOnce(new SovereignMemoryError('nope', 403));
      await expect(saveConvo({}, { conversationId: 'c1' }, {}, 'tok')).rejects.toMatchObject({
        status: 403,
      });
    });

    it('propagates MissingAccessTokenError when no token is available', async () => {
      callConsoleConversationsProxy.mockRejectedValueOnce(new MissingAccessTokenError());
      await expect(saveConvo({}, { conversationId: 'c1' }, {}, null)).rejects.toBeInstanceOf(
        MissingAccessTokenError,
      );
    });

    describe('metadata-clobber guard (2026-09-11 remediation)', () => {
      const EXISTING_WITH_STATE = {
        ...CONVO_ITEM,
        is_temporary: true,
        metadata: { isArchived: true, pinned: true, tags: ['x'] },
      };

      it('preserves isTemporary/isArchived/pinned/tags from the existing row when the caller omits them (a title-only update)', async () => {
        callConsoleConversationsProxy
          .mockResolvedValueOnce(EXISTING_WITH_STATE) // existing-fetch GET
          .mockResolvedValueOnce(CONVO_ITEM); // the POST
        await saveConvo({}, { conversationId: 'c1', title: 'New title' }, {}, 'tok');
        expect(callConsoleConversationsProxy).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            body: expect.objectContaining({
              is_temporary: true,
              metadata: { isArchived: true, pinned: true, tags: ['x'] },
            }),
          }),
        );
      });

      it('an explicit caller value always overrides the preserved existing value', async () => {
        callConsoleConversationsProxy
          .mockResolvedValueOnce(EXISTING_WITH_STATE)
          .mockResolvedValueOnce(CONVO_ITEM);
        await saveConvo({}, { conversationId: 'c1', isArchived: false }, {}, 'tok');
        expect(callConsoleConversationsProxy).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            body: expect.objectContaining({
              metadata: { isArchived: false, pinned: true, tags: ['x'] },
            }),
          }),
        );
      });

      it('an explicit ctx.isTemporary always overrides the existing value', async () => {
        callConsoleConversationsProxy
          .mockResolvedValueOnce(EXISTING_WITH_STATE)
          .mockResolvedValueOnce(CONVO_ITEM);
        await saveConvo({ isTemporary: false }, { conversationId: 'c1' }, {}, 'tok');
        expect(callConsoleConversationsProxy).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({ body: expect.objectContaining({ is_temporary: false }) }),
        );
      });
    });
  });

  describe('getConvosByCursor', () => {
    it('maps items + next_cursor, forwarding cursor/limit', async () => {
      callConsoleConversationsProxy.mockResolvedValueOnce({
        items: [CONVO_ITEM],
        next_cursor: 'abc',
      });
      const result = await getConvosByCursor('u1', { cursor: 'prev', limit: 10 }, 'tok');
      expect(callConsoleConversationsProxy).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          path: '',
          token: 'tok',
          query: { cursor: 'prev', limit: '10' },
        }),
      );
      expect(result.conversations).toHaveLength(1);
      expect(result.conversations[0].conversationId).toBe('c1');
      expect(result.nextCursor).toBe('abc');
    });

    it('defaults nextCursor to null and tolerates a missing items array', async () => {
      callConsoleConversationsProxy.mockResolvedValueOnce({});
      const result = await getConvosByCursor('u1', {}, 'tok');
      expect(result).toEqual({ conversations: [], nextCursor: null });
    });
  });

  describe('getConvo', () => {
    it('returns the mapped item on 2xx', async () => {
      callConsoleConversationsProxy.mockResolvedValueOnce(CONVO_ITEM);
      const result = await getConvo('u1', 'c1', 'tok');
      expect(result.conversationId).toBe('c1');
    });

    it("returns null on a 404 (not found/not owned) — Mongo's own no-match contract", async () => {
      callConsoleConversationsProxy.mockRejectedValueOnce(new SovereignMemoryError('gone', 404));
      const result = await getConvo('u1', 'missing', 'tok');
      expect(result).toBeNull();
    });

    it('fails closed on a non-404 non-2xx', async () => {
      callConsoleConversationsProxy.mockRejectedValueOnce(new SovereignMemoryError('nope', 500));
      await expect(getConvo('u1', 'c1', 'tok')).rejects.toMatchObject({ status: 500 });
    });
  });

  describe('setConvoPinned', () => {
    it('delegates to saveConvo, preserving other existing state', async () => {
      callConsoleConversationsProxy
        .mockResolvedValueOnce({ ...CONVO_ITEM, metadata: { tags: ['keep-me'] } }) // existing-fetch
        .mockResolvedValueOnce({ ...CONVO_ITEM, metadata: { pinned: true, tags: ['keep-me'] } }); // upsert
      const result = await setConvoPinned('u1', 'c1', true, 'tok');
      expect(callConsoleConversationsProxy).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({ metadata: { pinned: true, tags: ['keep-me'] } }),
        }),
      );
      expect(result.pinned).toBe(true);
      expect(result.tags).toEqual(['keep-me']);
    });
  });

  describe('deleteConvos', () => {
    it('deletes an explicit single conversationId', async () => {
      callConsoleConversationsProxy.mockResolvedValueOnce(undefined);
      const result = await deleteConvos('u1', { conversationId: 'c1' }, undefined, 'tok');
      expect(callConsoleConversationsProxy).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'DELETE', path: 'c1', token: 'tok' }),
      );
      expect(result).toEqual({ deletedCount: 1, conversationIds: ['c1'] });
    });

    it('deletes every id in a $in filter', async () => {
      callConsoleConversationsProxy.mockResolvedValue(undefined);
      const result = await deleteConvos(
        'u1',
        { conversationId: { $in: ['c1', 'c2'] } },
        undefined,
        'tok',
      );
      expect(callConsoleConversationsProxy).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ deletedCount: 2, conversationIds: ['c1', 'c2'] });
    });

    it('pages through every owned conversation when no id is named (delete-all)', async () => {
      callConsoleConversationsProxy
        .mockResolvedValueOnce({
          items: [{ ...CONVO_ITEM, conversation_id: 'c1' }],
          next_cursor: 'p2',
        })
        .mockResolvedValueOnce({
          items: [{ ...CONVO_ITEM, conversation_id: 'c2' }],
          next_cursor: null,
        })
        .mockResolvedValueOnce(undefined) // DELETE c1
        .mockResolvedValueOnce(undefined); // DELETE c2

      const result = await deleteConvos('u1', {}, undefined, 'tok');
      expect(result).toEqual({ deletedCount: 2, conversationIds: ['c1', 'c2'] });
    });

    it('tolerates a 404 per-id (already deleted) without failing the whole call', async () => {
      callConsoleConversationsProxy
        .mockRejectedValueOnce(new SovereignMemoryError('gone', 404))
        .mockResolvedValueOnce(undefined);
      const result = await deleteConvos(
        'u1',
        { conversationId: { $in: ['c1', 'c2'] } },
        undefined,
        'tok',
      );
      expect(result).toEqual({ deletedCount: 1, conversationIds: ['c2'] });
    });

    it('fails closed on a non-404 delete error', async () => {
      callConsoleConversationsProxy.mockRejectedValueOnce(new SovereignMemoryError('nope', 500));
      await expect(
        deleteConvos('u1', { conversationId: 'c1' }, undefined, 'tok'),
      ).rejects.toMatchObject({ status: 500 });
    });

    describe('options.beforeDelete (the generation-drain hook)', () => {
      it('is invoked with the resolved id list BEFORE any delete is issued', async () => {
        const order = [];
        const beforeDelete = jest.fn(async (ids) => {
          order.push(['beforeDelete', ids]);
        });
        callConsoleConversationsProxy.mockImplementation(async ({ method, path }) => {
          order.push([method, path]);
        });
        await deleteConvos('u1', { conversationId: 'c1' }, { beforeDelete }, 'tok');
        expect(beforeDelete).toHaveBeenCalledWith(['c1']);
        expect(order).toEqual([
          ['beforeDelete', ['c1']],
          ['DELETE', 'c1'],
        ]);
      });

      it('is NOT invoked when there is nothing to delete', async () => {
        const beforeDelete = jest.fn();
        callConsoleConversationsProxy.mockResolvedValueOnce({ items: [], next_cursor: null });
        await deleteConvos('u1', {}, { beforeDelete }, 'tok');
        expect(beforeDelete).not.toHaveBeenCalled();
      });
    });
  });

  describe('saveMessage', () => {
    it('POSTs the mapped body under the conversation and returns the mapped item', async () => {
      callConsoleConversationsProxy.mockResolvedValueOnce(MESSAGE_ITEM);
      const result = await saveMessage(
        { userId: 'u1' },
        { conversationId: 'c1', messageId: 'm1', text: 'hi', isCreatedByUser: true },
        {},
        'tok',
      );
      expect(callConsoleConversationsProxy).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'POST', path: 'c1/messages', token: 'tok' }),
      );
      expect(result.messageId).toBe('m1');
    });

    it('never reaches the BFF without conversationId+messageId — 400 locally', async () => {
      await expect(saveMessage({}, { conversationId: 'c1' }, {}, 'tok')).rejects.toMatchObject({
        status: 400,
      });
      expect(callConsoleConversationsProxy).not.toHaveBeenCalled();
    });

    it('carries content/userSubmittedPaths through the metadata bag', async () => {
      callConsoleConversationsProxy.mockResolvedValueOnce(MESSAGE_ITEM);
      await saveMessage(
        {},
        {
          conversationId: 'c1',
          messageId: 'm1',
          content: [{ type: 'text', text: 'hi' }],
          userSubmittedPaths: ['/text'],
        },
        {},
        'tok',
      );
      expect(callConsoleConversationsProxy).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            metadata: { content: [{ type: 'text', text: 'hi' }], userSubmittedPaths: ['/text'] },
          }),
        }),
      );
    });
  });

  describe('updateMessage', () => {
    it('PATCHes text and returns the mapped item (no prior metadata — existing-fetch 404s)', async () => {
      callConsoleConversationsProxy
        .mockRejectedValueOnce(NOT_FOUND) // existing-fetch GET (message tree, 404)
        .mockResolvedValueOnce(MESSAGE_ITEM); // the PATCH
      const result = await updateMessage(
        'u1',
        { conversationId: 'c1', messageId: 'm1', text: 'edited' },
        {},
        'tok',
      );
      expect(callConsoleConversationsProxy).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          method: 'PATCH',
          path: 'c1/messages/m1',
          token: 'tok',
          body: { text: 'edited' },
        }),
      );
      expect(result.messageId).toBe('m1');
    });

    it('requires conversationId — 400 locally, never a guess', async () => {
      await expect(updateMessage('u1', { messageId: 'm1' }, {}, 'tok')).rejects.toMatchObject({
        status: 400,
      });
      expect(callConsoleConversationsProxy).not.toHaveBeenCalled();
    });

    describe('metadata-clobber guard (2026-09-11 remediation)', () => {
      it('merges the existing message metadata under the caller delta (a text-only edit preserves prior content)', async () => {
        callConsoleConversationsProxy
          .mockResolvedValueOnce({
            items: [{ ...MESSAGE_ITEM, metadata: { content: [{ type: 'text', text: 'old' }] } }],
          }) // existing-fetch (message tree)
          .mockResolvedValueOnce(MESSAGE_ITEM); // the PATCH
        await updateMessage(
          'u1',
          { conversationId: 'c1', messageId: 'm1', text: 'new text' },
          {},
          'tok',
        );
        expect(callConsoleConversationsProxy).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            body: {
              text: 'new text',
              metadata: { content: [{ type: 'text', text: 'old' }] },
            },
          }),
        );
      });

      it('an explicit content edit overrides the preserved existing content', async () => {
        callConsoleConversationsProxy
          .mockResolvedValueOnce({
            items: [{ ...MESSAGE_ITEM, metadata: { content: [{ type: 'text', text: 'old' }] } }],
          })
          .mockResolvedValueOnce(MESSAGE_ITEM);
        await updateMessage(
          'u1',
          {
            conversationId: 'c1',
            messageId: 'm1',
            content: [{ type: 'text', text: 'new' }],
            tokenCount: 42,
          },
          {},
          'tok',
        );
        expect(callConsoleConversationsProxy).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            body: expect.objectContaining({
              metadata: { content: [{ type: 'text', text: 'new' }], tokenCount: 42 },
            }),
          }),
        );
      });

      it('an updated tokenCount round-trips through metadata (WU-1 PATCH has no token_count column)', async () => {
        callConsoleConversationsProxy
          .mockResolvedValueOnce({ items: [MESSAGE_ITEM] })
          .mockResolvedValueOnce({ ...MESSAGE_ITEM, metadata: { tokenCount: 7 } });
        const result = await updateMessage(
          'u1',
          { conversationId: 'c1', messageId: 'm1', text: 'x', tokenCount: 7 },
          {},
          'tok',
        );
        expect(callConsoleConversationsProxy).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            body: expect.objectContaining({ metadata: { tokenCount: 7 } }),
          }),
        );
        expect(result.tokenCount).toBe(7);
      });
    });
  });

  describe('getMessages', () => {
    it('GETs the message tree and maps every item', async () => {
      callConsoleConversationsProxy.mockResolvedValueOnce({ items: [MESSAGE_ITEM] });
      const result = await getMessages({ conversationId: 'c1', user: 'u1' }, 'select', {}, 'tok');
      expect(callConsoleConversationsProxy).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'GET', path: 'c1/messages', token: 'tok' }),
      );
      expect(result).toHaveLength(1);
      expect(result[0].messageId).toBe('m1');
    });

    it('requires filter.conversationId — 400 locally (no arbitrary Mongo filter support)', async () => {
      await expect(getMessages({ user: 'u1' }, undefined, undefined, 'tok')).rejects.toMatchObject({
        status: 400,
      });
      expect(callConsoleConversationsProxy).not.toHaveBeenCalled();
    });

    it('maps a 404 (conversation not found/not owned) to an empty array, not an error', async () => {
      callConsoleConversationsProxy.mockRejectedValueOnce(new SovereignMemoryError('gone', 404));
      const result = await getMessages({ conversationId: 'missing' }, undefined, undefined, 'tok');
      expect(result).toEqual([]);
    });

    it('fails closed on a non-404 non-2xx', async () => {
      callConsoleConversationsProxy.mockRejectedValueOnce(new SovereignMemoryError('nope', 500));
      await expect(
        getMessages({ conversationId: 'c1' }, undefined, undefined, 'tok'),
      ).rejects.toMatchObject({ status: 500 });
    });

    it('narrows to a single messageId when filter.messageId is a string', async () => {
      callConsoleConversationsProxy.mockResolvedValueOnce({
        items: [MESSAGE_ITEM, { ...MESSAGE_ITEM, message_id: 'm2' }],
      });
      const result = await getMessages(
        { conversationId: 'c1', messageId: 'm2' },
        undefined,
        undefined,
        'tok',
      );
      expect(result).toHaveLength(1);
      expect(result[0].messageId).toBe('m2');
    });

    it('narrows to a $in messageId set', async () => {
      callConsoleConversationsProxy.mockResolvedValueOnce({
        items: [
          MESSAGE_ITEM,
          { ...MESSAGE_ITEM, message_id: 'm2' },
          { ...MESSAGE_ITEM, message_id: 'm3' },
        ],
      });
      const result = await getMessages(
        { conversationId: 'c1', messageId: { $in: ['m1', 'm3'] } },
        undefined,
        undefined,
        'tok',
      );
      expect(result.map((m) => m.messageId).sort()).toEqual(['m1', 'm3']);
    });
  });

  describe('getMessagesByCursor', () => {
    const M1 = { ...MESSAGE_ITEM, message_id: 'm1', created_at_ms: 100 };
    const M2 = { ...MESSAGE_ITEM, message_id: 'm2', created_at_ms: 200 };
    const M3 = { ...MESSAGE_ITEM, message_id: 'm3', created_at_ms: 300 };

    it('requires filter.conversationId — 400 locally', async () => {
      await expect(getMessagesByCursor({}, {}, 'tok')).rejects.toMatchObject({ status: 400 });
      expect(callConsoleConversationsProxy).not.toHaveBeenCalled();
    });

    it('paginates the full message list locally (limit, then a follow-up cursor page)', async () => {
      callConsoleConversationsProxy.mockResolvedValue({ items: [M1, M2, M3] });
      const page1 = await getMessagesByCursor(
        { conversationId: 'c1' },
        { limit: 2, sortField: 'createdAt', sortOrder: 1 },
        'tok',
      );
      expect(page1.messages.map((m) => m.messageId)).toEqual(['m1', 'm2']);
      expect(page1.nextCursor).toBe('2');

      const page2 = await getMessagesByCursor(
        { conversationId: 'c1' },
        { limit: 2, sortField: 'createdAt', sortOrder: 1, cursor: page1.nextCursor },
        'tok',
      );
      expect(page2.messages.map((m) => m.messageId)).toEqual(['m3']);
      expect(page2.nextCursor).toBeNull();
    });

    it('defaults to descending createdAt order', async () => {
      callConsoleConversationsProxy.mockResolvedValue({ items: [M1, M2, M3] });
      const result = await getMessagesByCursor({ conversationId: 'c1' }, {}, 'tok');
      expect(result.messages.map((m) => m.messageId)).toEqual(['m3', 'm2', 'm1']);
    });
  });

  describe('getMessage', () => {
    it('finds the matching message within the conversation tree', async () => {
      callConsoleConversationsProxy.mockResolvedValueOnce({
        items: [MESSAGE_ITEM, { ...MESSAGE_ITEM, message_id: 'm2' }],
      });
      const result = await getMessage({ user: 'u1', messageId: 'm2', conversationId: 'c1' }, 'tok');
      expect(result.messageId).toBe('m2');
    });

    it('returns null when the message id is not in the tree', async () => {
      callConsoleConversationsProxy.mockResolvedValueOnce({ items: [MESSAGE_ITEM] });
      const result = await getMessage(
        { user: 'u1', messageId: 'nope', conversationId: 'c1' },
        'tok',
      );
      expect(result).toBeNull();
    });

    it('requires messageId — 400 locally, never a guess', async () => {
      await expect(getMessage({ user: 'u1', conversationId: 'c1' }, 'tok')).rejects.toMatchObject({
        status: 400,
      });
      expect(callConsoleConversationsProxy).not.toHaveBeenCalled();
    });

    describe('bare messageId lookup (no conversationId) — Mongo global-lookup fallback', () => {
      it("scans the caller's own conversations and returns the first match", async () => {
        callConsoleConversationsProxy
          .mockResolvedValueOnce({
            items: [
              { ...CONVO_ITEM, conversation_id: 'c1' },
              { ...CONVO_ITEM, conversation_id: 'c2' },
            ],
            next_cursor: null,
          }) // collectAllConversationIds
          .mockResolvedValueOnce({ items: [] }) // c1 has no matching message
          .mockResolvedValueOnce({ items: [{ ...MESSAGE_ITEM, conversation_id: 'c2' }] }); // c2 does

        const result = await getMessage({ user: 'u1', messageId: 'm1' }, 'tok');
        expect(result.conversationId).toBe('c2');
      });

      it('returns null when no conversation contains the message', async () => {
        callConsoleConversationsProxy
          .mockResolvedValueOnce({
            items: [{ ...CONVO_ITEM, conversation_id: 'c1' }],
            next_cursor: null,
          })
          .mockResolvedValueOnce({ items: [] });
        const result = await getMessage({ user: 'u1', messageId: 'missing' }, 'tok');
        expect(result).toBeNull();
      });
    });
  });

  describe('deleteMessages', () => {
    it('deletes a single message when both conversationId and messageId are given', async () => {
      callConsoleConversationsProxy.mockResolvedValueOnce(undefined);
      const result = await deleteMessages({ conversationId: 'c1', messageId: 'm1' }, 'tok');
      expect(callConsoleConversationsProxy).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'DELETE', path: 'c1/messages/m1', token: 'tok' }),
      );
      expect(result).toEqual({ deletedCount: 1 });
    });

    it('a single-message delete tolerates a 404 (already gone)', async () => {
      callConsoleConversationsProxy.mockRejectedValueOnce(new SovereignMemoryError('gone', 404));
      const result = await deleteMessages({ conversationId: 'c1', messageId: 'm1' }, 'tok');
      expect(result).toEqual({ deletedCount: 0 });
    });

    it('a single-message delete fails closed on a non-404 error', async () => {
      callConsoleConversationsProxy.mockRejectedValueOnce(new SovereignMemoryError('nope', 500));
      await expect(
        deleteMessages({ conversationId: 'c1', messageId: 'm1' }, 'tok'),
      ).rejects.toMatchObject({ status: 500 });
    });

    it('deletes every message in an explicit conversation when messageId is absent (bulk-by-conversation)', async () => {
      callConsoleConversationsProxy
        .mockResolvedValueOnce({ items: [MESSAGE_ITEM, { ...MESSAGE_ITEM, message_id: 'm2' }] })
        .mockResolvedValueOnce(undefined) // DELETE m1
        .mockResolvedValueOnce(undefined); // DELETE m2

      const result = await deleteMessages({ conversationId: 'c1' }, 'tok');
      expect(result).toEqual({ deletedCount: 2 });
      expect(callConsoleConversationsProxy).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'DELETE', path: 'c1/messages/m1', token: 'tok' }),
      );
      expect(callConsoleConversationsProxy).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'DELETE', path: 'c1/messages/m2', token: 'tok' }),
      );
    });

    it('tolerates a 404 per-message without failing the whole bulk call', async () => {
      callConsoleConversationsProxy
        .mockResolvedValueOnce({ items: [MESSAGE_ITEM] })
        .mockRejectedValueOnce(new SovereignMemoryError('gone', 404));
      const result = await deleteMessages({ conversationId: 'c1' }, 'tok');
      expect(result).toEqual({ deletedCount: 0 });
    });

    it('pages through every owned conversation when no id is named (delete-all-messages)', async () => {
      callConsoleConversationsProxy
        .mockResolvedValueOnce({
          items: [{ ...CONVO_ITEM, conversation_id: 'c1' }],
          next_cursor: null,
        }) // collectAllConversationIds
        .mockResolvedValueOnce({ items: [MESSAGE_ITEM] }) // c1's messages
        .mockResolvedValueOnce(undefined); // DELETE m1
      const result = await deleteMessages({ user: 'u1' }, 'tok');
      expect(result).toEqual({ deletedCount: 1 });
    });
  });

  describe('bulkSaveConvos', () => {
    it('fans out to individual saveConvo calls and returns a count', async () => {
      // `bulkSaveConvos` fans out via `Promise.all`, so the two items' own
      // existing-fetch-then-upsert calls interleave rather than running
      // strictly one-after-another — branch on `method` instead of trying
      // to predict the exact interleaved call order.
      callConsoleConversationsProxy.mockImplementation(async ({ method }) => {
        if (method === 'GET') {
          throw new SovereignMemoryError('not found', 404);
        }
        return CONVO_ITEM;
      });
      const result = await bulkSaveConvos(
        [
          { conversationId: 'c1', title: 'One' },
          { conversationId: 'c2', title: 'Two' },
        ],
        'tok',
      );
      expect(result).toEqual({ ok: true, count: 2 });
    });

    it('tolerates an empty/non-array input', async () => {
      const result = await bulkSaveConvos(undefined, 'tok');
      expect(result).toEqual({ ok: true, count: 0 });
      expect(callConsoleConversationsProxy).not.toHaveBeenCalled();
    });

    it('fails closed if any item fails', async () => {
      callConsoleConversationsProxy
        .mockRejectedValueOnce(NOT_FOUND)
        .mockRejectedValueOnce(new SovereignMemoryError('nope', 500));
      await expect(bulkSaveConvos([{ conversationId: 'c1' }], 'tok')).rejects.toMatchObject({
        status: 500,
      });
    });
  });

  describe('bulkSaveMessages', () => {
    it('fans out to individual saveMessage calls and returns a count', async () => {
      callConsoleConversationsProxy
        .mockResolvedValueOnce(MESSAGE_ITEM)
        .mockResolvedValueOnce({ ...MESSAGE_ITEM, message_id: 'm2' });
      const result = await bulkSaveMessages(
        [
          { conversationId: 'c1', messageId: 'm1', text: 'hi' },
          { conversationId: 'c1', messageId: 'm2', text: 'there' },
        ],
        true,
        'tok',
      );
      expect(result).toEqual({ ok: true, count: 2 });
    });

    it('tolerates an empty/non-array input', async () => {
      const result = await bulkSaveMessages(undefined, true, 'tok');
      expect(result).toEqual({ ok: true, count: 0 });
      expect(callConsoleConversationsProxy).not.toHaveBeenCalled();
    });
  });

  describe('wrapModelMethods — THE CHOKEPOINT (MongoDB-elimination WU-2b)', () => {
    const buildMongoMethods = () => ({
      saveConvo: jest.fn().mockResolvedValue({ mongo: true }),
      getConvosByCursor: jest.fn().mockResolvedValue({ conversations: [], nextCursor: null }),
      getConvo: jest.fn().mockResolvedValue(null),
      getConvoOwnership: jest.fn().mockResolvedValue(null),
      setConvoPinned: jest.fn().mockResolvedValue({ mongo: true }),
      deleteConvos: jest.fn().mockResolvedValue({ deletedCount: 0, conversationIds: [] }),
      saveMessage: jest.fn().mockResolvedValue({ mongo: true }),
      updateMessage: jest.fn().mockResolvedValue({ mongo: true }),
      getMessages: jest.fn().mockResolvedValue([]),
      getMessagesByCursor: jest.fn().mockResolvedValue({ messages: [], nextCursor: null }),
      getMessage: jest.fn().mockResolvedValue(null),
      deleteMessages: jest.fn().mockResolvedValue({ deletedCount: 0 }),
      bulkSaveConvos: jest.fn().mockResolvedValue({ mongo: true }),
      bulkSaveMessages: jest.fn().mockResolvedValue({ mongo: true }),
      // A non-conversation/message export (e.g. `getUserById`) — must
      // pass through wrapModelMethods completely untouched.
      getUserById: jest.fn().mockResolvedValue({ mongo: true }),
    });

    it('under the default mongo flag, every wrapped call still reaches the raw Mongo function unchanged', async () => {
      delete process.env.AUDITTRACE_MEMORY_BACKEND;
      const mongoMethods = buildMongoMethods();
      const wrapped = wrapModelMethods(mongoMethods);
      await wrapped.getConvo('u1', 'c1');
      expect(mongoMethods.getConvo).toHaveBeenCalledWith('u1', 'c1');
      expect(callConsoleConversationsProxy).not.toHaveBeenCalled();
    });

    it('also falls to Mongo for a non-"sovereign" flag value (fail-closed to mongo)', async () => {
      process.env.AUDITTRACE_MEMORY_BACKEND = 'typo-value';
      const mongoMethods = buildMongoMethods();
      const wrapped = wrapModelMethods(mongoMethods);
      await wrapped.getConvo('u1', 'c1');
      expect(mongoMethods.getConvo).toHaveBeenCalled();
      expect(callConsoleConversationsProxy).not.toHaveBeenCalled();
    });

    it('passes through a non-chokepointed key completely unchanged (same function reference)', () => {
      process.env.AUDITTRACE_MEMORY_BACKEND = 'sovereign';
      const mongoMethods = buildMongoMethods();
      const wrapped = wrapModelMethods(mongoMethods);
      expect(wrapped.getUserById).toBe(mongoMethods.getUserById);
    });

    it('under sovereign but with NO request-context token, every chokepointed call still falls to Mongo', async () => {
      process.env.AUDITTRACE_MEMORY_BACKEND = 'sovereign';
      const mongoMethods = buildMongoMethods();
      const wrapped = wrapModelMethods(mongoMethods);
      // No runWithRequestAccessToken() wrapper — simulates a background/
      // scheduled job with no live HTTP request (the disclosed boundary).
      await wrapped.getConvo('u1', 'c1');
      expect(mongoMethods.getConvo).toHaveBeenCalledWith('u1', 'c1');
      expect(callConsoleConversationsProxy).not.toHaveBeenCalled();
    });

    it('under sovereign WITH a request-context token, routes to the sovereign adapter and NEVER calls the Mongo function', async () => {
      process.env.AUDITTRACE_MEMORY_BACKEND = 'sovereign';
      const mongoMethods = buildMongoMethods();
      const wrapped = wrapModelMethods(mongoMethods);
      callConsoleConversationsProxy.mockResolvedValueOnce(CONVO_ITEM);

      const result = await runWithRequestAccessToken({ accessToken: 'user-bearer-token' }, () =>
        wrapped.getConvo('u1', 'c1'),
      );

      expect(result.conversationId).toBe('c1');
      expect(callConsoleConversationsProxy).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'GET', path: 'c1', token: 'user-bearer-token' }),
      );
      expect(mongoMethods.getConvo).not.toHaveBeenCalled();
    });

    it('getConvoOwnership is bound to the SAME implementation as getConvo (an existence+ownership alias)', async () => {
      process.env.AUDITTRACE_MEMORY_BACKEND = 'sovereign';
      const mongoMethods = { getConvoOwnership: jest.fn() };
      const wrapped = wrapModelMethods(mongoMethods);
      callConsoleConversationsProxy.mockResolvedValueOnce(CONVO_ITEM);

      const result = await runWithRequestAccessToken({ accessToken: 'tok' }, () =>
        wrapped.getConvoOwnership('u1', 'c1'),
      );

      expect(result.conversationId).toBe('c1');
      expect(callConsoleConversationsProxy).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'GET', path: 'c1', token: 'tok' }),
      );
      expect(mongoMethods.getConvoOwnership).not.toHaveBeenCalled();
    });

    /**
     * STRUCTURAL-COMPLETENESS proof: simulates `services/Schedules/index.js`
     * threading `require('~/models')` in as an injected `methods`
     * constructor param — the exact caller shape that evaded three rounds
     * of route-level, name-based-enumeration wiring. Since `wrapped` here
     * is the SAME kind of object `require('~/models')` now exports (every
     * caller shape receives it), an injected-methods caller with a
     * request-context token routes sovereign with NO additional wiring of
     * its own.
     */
    it('an injected-methods-param caller (the schedules/agent-trigger shape) routes sovereign under a request-context token, with NO per-caller wiring', async () => {
      process.env.AUDITTRACE_MEMORY_BACKEND = 'sovereign';
      const mongoMethods = buildMongoMethods();
      const wrapped = wrapModelMethods(mongoMethods);
      // Mirrors `createSchedulesService({ methods: require('~/models'), ... })`:
      // some OTHER subsystem receives the wrapped object as a constructor
      // param and calls a method off it — no `resolveConversationMethods`
      // or `conversationDb` concept exists at that call site anymore.
      function injectedMethodsCaller({ methods }) {
        return methods.saveConvo({ userId: 'u1' }, { conversationId: 'c1' }, {});
      }
      callConsoleConversationsProxy
        .mockRejectedValueOnce(new SovereignMemoryError('not found', 404)) // existing-fetch
        .mockResolvedValueOnce(CONVO_ITEM); // upsert

      const result = await runWithRequestAccessToken(
        { accessToken: 'schedule-run-now-token' },
        () => injectedMethodsCaller({ methods: wrapped }),
      );

      expect(result.conversationId).toBe('c1');
      expect(callConsoleConversationsProxy).toHaveBeenCalledWith(
        expect.objectContaining({ token: 'schedule-run-now-token' }),
      );
      expect(mongoMethods.saveConvo).not.toHaveBeenCalled();
    });

    /**
     * THE ONE HONEST BOUNDARY: a background/scheduled run with NO live
     * request (no `runWithRequestAccessToken` wrapper at all — a genuine
     * cron-style fire, not a "run now" triggered inside a request) has no
     * token to read, so it falls to Mongo even under the sovereign flag.
     * This is the single disclosed category the ratified spec names —
     * verified here at the SAME injected-methods-param call shape as the
     * "routes sovereign" test above, differing ONLY in the absence of a
     * request context.
     */
    it('the SAME injected-methods-param caller falls to Mongo with NO live request context (the disclosed background-writes boundary)', async () => {
      process.env.AUDITTRACE_MEMORY_BACKEND = 'sovereign';
      const mongoMethods = buildMongoMethods();
      const wrapped = wrapModelMethods(mongoMethods);
      function injectedMethodsCaller({ methods }) {
        return methods.saveConvo({ userId: 'u1' }, { conversationId: 'c1' }, {});
      }

      await injectedMethodsCaller({ methods: wrapped });

      expect(mongoMethods.saveConvo).toHaveBeenCalledWith(
        { userId: 'u1' },
        { conversationId: 'c1' },
        {},
      );
      expect(callConsoleConversationsProxy).not.toHaveBeenCalled();
    });

    /**
     * NON-VACUOUS guard, per the ratified spec's acceptance criterion:
     * "disable the chokepoint branch (force the model exports to always
     * use Mongo) -> the sovereign-path assertions go RED across the
     * specs; restore -> green." Verified by hand during the build:
     * temporarily hardcoding `wrapModelMethods` to `return mongoMethods`
     * unchanged (dropping the chokepoint branch entirely) turns every
     * "routes sovereign"/"NEVER calls the Mongo function" assertion in
     * this describe block RED; restored, re-verified GREEN. See the
     * build record.
     */
    it('under sovereign with a token, forwards EVERY chokepointed method to the adapter and NEVER calls the injected Mongo functions', async () => {
      process.env.AUDITTRACE_MEMORY_BACKEND = 'sovereign';
      const mongoMethods = buildMongoMethods();
      const wrapped = wrapModelMethods(mongoMethods);

      // Each call is isolated (mock reset immediately before it) so the
      // exact number/order of internal existing-fetch GETs a given method
      // now issues (saveConvo, updateMessage) never needs to be
      // re-derived here — this test only asserts WHICH function ends up
      // hitting the adapter's HTTP boundary, not its internal call count.
      const freshStub = (impl) => {
        callConsoleConversationsProxy.mockReset();
        callConsoleConversationsProxy.mockImplementation(impl);
      };
      const notFound = async () => {
        throw new SovereignMemoryError('not found', 404);
      };

      await runWithRequestAccessToken({ accessToken: 'user-bearer-token' }, async () => {
        freshStub(notFound);
        callConsoleConversationsProxy
          .mockImplementationOnce(notFound)
          .mockResolvedValueOnce(CONVO_ITEM);
        await wrapped.saveConvo({ userId: 'u1' }, { conversationId: 'c1' }, {});

        freshStub(async () => ({ items: [], next_cursor: null }));
        await wrapped.getConvosByCursor('u1', {});

        freshStub(async () => CONVO_ITEM);
        await wrapped.getConvo('u1', 'c1');
        await wrapped.getConvoOwnership('u1', 'c1');

        freshStub(notFound);
        callConsoleConversationsProxy
          .mockImplementationOnce(notFound)
          .mockResolvedValueOnce(CONVO_ITEM);
        await wrapped.setConvoPinned('u1', 'c1', true);

        freshStub(async () => undefined);
        await wrapped.deleteConvos('u1', { conversationId: 'c1' });

        freshStub(async () => MESSAGE_ITEM);
        await wrapped.saveMessage({ userId: 'u1' }, { conversationId: 'c1', messageId: 'm1' }, {});

        freshStub(notFound);
        callConsoleConversationsProxy
          .mockImplementationOnce(notFound)
          .mockResolvedValueOnce(MESSAGE_ITEM);
        await wrapped.updateMessage('u1', { conversationId: 'c1', messageId: 'm1', text: 'x' }, {});

        freshStub(async () => ({ items: [MESSAGE_ITEM] }));
        await wrapped.getMessages({ conversationId: 'c1' });

        freshStub(async () => ({ items: [MESSAGE_ITEM] }));
        await wrapped.getMessagesByCursor({ conversationId: 'c1' });

        freshStub(async () => ({ items: [MESSAGE_ITEM] }));
        await wrapped.getMessage({ conversationId: 'c1', messageId: 'm1' });

        freshStub(async ({ method }) => (method === 'GET' ? { items: [MESSAGE_ITEM] } : undefined));
        await wrapped.deleteMessages({ conversationId: 'c1' });

        freshStub(notFound);
        callConsoleConversationsProxy
          .mockImplementationOnce(notFound)
          .mockResolvedValueOnce(CONVO_ITEM);
        await wrapped.bulkSaveConvos([{ conversationId: 'c1' }]);

        freshStub(async () => MESSAGE_ITEM);
        await wrapped.bulkSaveMessages([{ conversationId: 'c1', messageId: 'm1' }], true);
      });

      // The adapter's HTTP boundary was used with the forwarded token...
      expect(callConsoleConversationsProxy).toHaveBeenCalledWith(
        expect.objectContaining({ token: 'user-bearer-token' }),
      );
      // ...and NONE of the caller's own Mongo functions were ever invoked.
      for (const fn of Object.values(mongoMethods)) {
        if (fn === mongoMethods.getUserById) {
          continue; // not chokepointed, irrelevant to this assertion
        }
        expect(fn).not.toHaveBeenCalled();
      }
    });

    it('under sovereign with a token but the sovereign call itself fails, fails closed rather than silently falling back to Mongo', async () => {
      process.env.AUDITTRACE_MEMORY_BACKEND = 'sovereign';
      const mongoMethods = buildMongoMethods();
      const wrapped = wrapModelMethods(mongoMethods);
      callConsoleConversationsProxy.mockRejectedValueOnce(new SovereignMemoryError('boom', 500));

      await expect(
        runWithRequestAccessToken({ accessToken: 'tok' }, () => wrapped.getConvo('u1', 'c1')),
      ).rejects.toMatchObject({ status: 500 });
      expect(mongoMethods.getConvo).not.toHaveBeenCalled();
    });
  });
});
