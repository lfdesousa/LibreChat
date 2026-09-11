jest.mock('./client', () => ({ callConsoleConversationsProxy: jest.fn() }));

const { callConsoleConversationsProxy } = require('./client');
const {
  saveConvo,
  getConvosByCursor,
  getConvo,
  deleteConvos,
  saveMessage,
  updateMessage,
  getMessages,
  getMessage,
  deleteMessages,
  resolveConversationMethods,
} = require('./index');
const { SovereignMemoryError, MissingAccessTokenError } = require('../AuditTraceMemory/errors');

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

describe('AuditTraceConversations adapter (MongoDB-elimination WU-2)', () => {
  describe('saveConvo', () => {
    it('POSTs the mapped body and returns the mapped item', async () => {
      callConsoleConversationsProxy.mockResolvedValueOnce(CONVO_ITEM);
      const result = await saveConvo(
        { userId: 'u1' },
        { conversationId: 'c1', title: 'Hello' },
        {},
        'tok',
      );
      expect(callConsoleConversationsProxy).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          path: '',
          token: 'tok',
          body: expect.objectContaining({ conversation_id: 'c1', title: 'Hello' }),
        }),
      );
      expect(result.conversationId).toBe('c1');
      expect(result.user).toBe('u1');
    });

    it('never reaches the BFF without a conversationId — 400 locally', async () => {
      await expect(saveConvo({}, {}, {}, 'tok')).rejects.toMatchObject({ status: 400 });
      expect(callConsoleConversationsProxy).not.toHaveBeenCalled();
    });

    it('fails closed on a non-2xx — the error propagates, never a Mongo fallback', async () => {
      callConsoleConversationsProxy.mockRejectedValueOnce(new SovereignMemoryError('nope', 403));
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

  describe('deleteConvos', () => {
    it('deletes an explicit single conversationId', async () => {
      callConsoleConversationsProxy.mockResolvedValueOnce(undefined);
      const result = await deleteConvos('u1', { conversationId: 'c1' }, 'tok');
      expect(callConsoleConversationsProxy).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'DELETE', path: 'c1', token: 'tok' }),
      );
      expect(result).toEqual({ deletedCount: 1, conversationIds: ['c1'] });
    });

    it('deletes every id in a $in filter', async () => {
      callConsoleConversationsProxy.mockResolvedValue(undefined);
      const result = await deleteConvos('u1', { conversationId: { $in: ['c1', 'c2'] } }, 'tok');
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

      const result = await deleteConvos('u1', {}, 'tok');
      expect(result).toEqual({ deletedCount: 2, conversationIds: ['c1', 'c2'] });
    });

    it('tolerates a 404 per-id (already deleted) without failing the whole call', async () => {
      callConsoleConversationsProxy
        .mockRejectedValueOnce(new SovereignMemoryError('gone', 404))
        .mockResolvedValueOnce(undefined);
      const result = await deleteConvos('u1', { conversationId: { $in: ['c1', 'c2'] } }, 'tok');
      expect(result).toEqual({ deletedCount: 1, conversationIds: ['c2'] });
    });

    it('fails closed on a non-404 delete error', async () => {
      callConsoleConversationsProxy.mockRejectedValueOnce(new SovereignMemoryError('nope', 500));
      await expect(deleteConvos('u1', { conversationId: 'c1' }, 'tok')).rejects.toMatchObject({
        status: 500,
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
  });

  describe('updateMessage', () => {
    it('PATCHes text/metadata and returns the mapped item', async () => {
      callConsoleConversationsProxy.mockResolvedValueOnce(MESSAGE_ITEM);
      const result = await updateMessage(
        'u1',
        { conversationId: 'c1', messageId: 'm1', text: 'edited' },
        {},
        'tok',
      );
      expect(callConsoleConversationsProxy).toHaveBeenCalledWith(
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

    it('requires conversationId — 400 locally (bare messageId lookup has no sovereign equivalent)', async () => {
      await expect(getMessage({ user: 'u1', messageId: 'm1' }, 'tok')).rejects.toMatchObject({
        status: 400,
      });
      expect(callConsoleConversationsProxy).not.toHaveBeenCalled();
    });
  });

  describe('deleteMessages', () => {
    it('deletes every message in an explicit conversation', async () => {
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

    it('tolerates a 404 per-message without failing the whole call', async () => {
      callConsoleConversationsProxy
        .mockResolvedValueOnce({ items: [MESSAGE_ITEM] })
        .mockRejectedValueOnce(new SovereignMemoryError('gone', 404));
      const result = await deleteMessages({ conversationId: 'c1' }, 'tok');
      expect(result).toEqual({ deletedCount: 0 });
    });
  });

  describe('resolveConversationMethods — the Mongo-vs-sovereign routing seam', () => {
    const buildMongoMethods = () => ({
      saveConvo: jest.fn().mockResolvedValue({ mongo: true }),
      getConvosByCursor: jest.fn().mockResolvedValue({ conversations: [], nextCursor: null }),
      getConvo: jest.fn().mockResolvedValue(null),
      deleteConvos: jest.fn().mockResolvedValue({ deletedCount: 0, conversationIds: [] }),
      saveMessage: jest.fn().mockResolvedValue({ mongo: true }),
      updateMessage: jest.fn().mockResolvedValue({ mongo: true }),
      getMessages: jest.fn().mockResolvedValue([]),
      getMessage: jest.fn().mockResolvedValue(null),
      deleteMessages: jest.fn().mockResolvedValue({ deletedCount: 0 }),
    });

    it('returns mongoMethods UNCHANGED (same reference) under the default mongo flag — byte-identical path', () => {
      delete process.env.AUDITTRACE_MEMORY_BACKEND;
      const mongoMethods = buildMongoMethods();
      const resolved = resolveConversationMethods({ req: {}, mongoMethods });
      expect(resolved).toBe(mongoMethods);
    });

    it('also returns mongoMethods unchanged for a non-"sovereign" value (fail-closed to mongo)', () => {
      process.env.AUDITTRACE_MEMORY_BACKEND = 'typo-value';
      const mongoMethods = buildMongoMethods();
      expect(resolveConversationMethods({ req: {}, mongoMethods })).toBe(mongoMethods);
    });

    it('under sovereign, binds only the keys present on mongoMethods, passing through an unrecognised key unchanged', () => {
      process.env.AUDITTRACE_MEMORY_BACKEND = 'sovereign';
      const unrelated = jest.fn();
      const mongoMethods = { getConvo: jest.fn(), notOneOfTheNine: unrelated };
      const resolved = resolveConversationMethods({ req: {}, mongoMethods });
      expect(resolved.getConvo).not.toBe(mongoMethods.getConvo);
      expect(resolved.notOneOfTheNine).toBe(unrelated);
    });

    /**
     * NON-VACUOUS guard, per the ratified spec's acceptance criterion:
     * "flip isSovereignBackend() off (or stub it) -> the method uses the
     * Mongo path and the sovereign-path test goes RED (proves the shim is
     * actually wired, not dead)." Verified by hand during the build:
     * temporarily hardcoding `resolveConversationMethods` to always
     * `return mongoMethods` (dropping the sovereign branch) turns every
     * assertion in this `it()` RED; restored, re-verified GREEN. See the
     * build record.
     */
    it('under sovereign, forwards every one of the 9 methods to the adapter and NEVER calls the injected Mongo functions', async () => {
      process.env.AUDITTRACE_MEMORY_BACKEND = 'sovereign';
      const mongoMethods = buildMongoMethods();
      const req = { session: { openidTokens: { accessToken: 'user-bearer-token' } } };
      const resolved = resolveConversationMethods({ req, mongoMethods });

      expect(resolved).not.toBe(mongoMethods);
      for (const name of Object.keys(mongoMethods)) {
        expect(resolved[name]).not.toBe(mongoMethods[name]);
      }

      callConsoleConversationsProxy.mockResolvedValue(CONVO_ITEM);
      await resolved.saveConvo({ userId: 'u1' }, { conversationId: 'c1' }, {});
      await resolved.getConvosByCursor('u1', {});
      await resolved.getConvo('u1', 'c1');
      await resolved.deleteConvos('u1', { conversationId: 'c1' });
      callConsoleConversationsProxy.mockResolvedValue(MESSAGE_ITEM);
      await resolved.saveMessage({ userId: 'u1' }, { conversationId: 'c1', messageId: 'm1' }, {});
      await resolved.updateMessage('u1', { conversationId: 'c1', messageId: 'm1', text: 'x' }, {});
      callConsoleConversationsProxy.mockResolvedValue({ items: [MESSAGE_ITEM] });
      await resolved.getMessages({ conversationId: 'c1' });
      await resolved.getMessage({ conversationId: 'c1', messageId: 'm1' });
      await resolved.deleteMessages({ conversationId: 'c1' });

      // The adapter's HTTP boundary was used with the forwarded token...
      expect(callConsoleConversationsProxy).toHaveBeenCalledWith(
        expect.objectContaining({ token: 'user-bearer-token' }),
      );
      // ...and NONE of the caller's own Mongo functions were ever invoked.
      for (const fn of Object.values(mongoMethods)) {
        expect(fn).not.toHaveBeenCalled();
      }
    });

    it('under sovereign with no session token, the adapter call fails closed rather than silently falling back to Mongo', async () => {
      process.env.AUDITTRACE_MEMORY_BACKEND = 'sovereign';
      const mongoMethods = buildMongoMethods();
      const resolved = resolveConversationMethods({ req: {}, mongoMethods });

      // No access token forwarded — `client.js` is mocked here (this
      // suite exercises the resolver seam, not the HTTP boundary), so the
      // no-token 401 is simulated at the same mocked boundary
      // `client.spec.js` proves it for real.
      callConsoleConversationsProxy.mockRejectedValueOnce(new MissingAccessTokenError());
      await expect(resolved.getConvo('u1', 'c1')).rejects.toBeInstanceOf(MissingAccessTokenError);
      expect(callConsoleConversationsProxy).toHaveBeenCalledWith(
        expect.objectContaining({ token: null }),
      );
      expect(mongoMethods.getConvo).not.toHaveBeenCalled();
    });
  });
});
