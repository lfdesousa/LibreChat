/**
 * Unit tests for the chat-project adapter (MongoDB-elimination
 * WU-chatprojects — the THIRD reuse of the WU-2b chokepoint). Mocks ONLY
 * the HTTP boundary (`./client`) — `index.js`'s own logic (fetch-then-merge
 * on update, id minting, binder arity) is REAL, unmocked code.
 */
jest.mock('./client', () => ({ callConsoleChatProjectsProxy: jest.fn() }));

const { callConsoleChatProjectsProxy } = require('./client');
const { SovereignMemoryError } = require('../AuditTraceMemory/errors');
const {
  createChatProject,
  getChatProject,
  listChatProjects,
  updateChatProject,
  deleteChatProject,
  SOVEREIGN_METHOD_BINDERS,
} = require('./index');

const OBJECT_ID_RE = /^[a-f0-9]{24}$/;

describe('AuditTraceChatProjects — the sovereign chat-project adapter', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('createChatProject', () => {
    it('requires a non-empty name — throws a 400, never silently no-ops', async () => {
      await expect(createChatProject('user-1', {}, 'tok')).rejects.toMatchObject({ status: 400 });
      await expect(createChatProject('user-1', { name: '   ' }, 'tok')).rejects.toMatchObject({
        status: 400,
      });
      expect(callConsoleChatProjectsProxy).not.toHaveBeenCalled();
    });

    it('mints a Mongo-ObjectId-shaped id and maps the result to the LibreChat shape', async () => {
      callConsoleChatProjectsProxy.mockResolvedValueOnce({
        chat_project_id: 'will-be-overwritten-by-mint',
        name: 'My Project',
        description: 'desc',
        created_at_ms: 0,
        updated_at_ms: 0,
        metadata: {},
      });

      const result = await createChatProject(
        'user-1',
        { name: 'My Project', description: 'desc' },
        'tok',
      );

      expect(result).toMatchObject({
        name: 'My Project',
        description: 'desc',
        user: 'user-1',
        conversationCount: 0,
        lastConversationAt: null,
        lastConversationId: null,
      });
      const call = callConsoleChatProjectsProxy.mock.calls[0][0];
      expect(call.method).toBe('POST');
      expect(call.path).toBe('');
      expect(call.token).toBe('tok');
      expect(call.body.chat_project_id).toMatch(OBJECT_ID_RE);
      expect(call.body.name).toBe('My Project');
    });

    it('trims and truncates name/description the SAME way Mongo sanitizeProjectInput does', async () => {
      callConsoleChatProjectsProxy.mockResolvedValueOnce({
        chat_project_id: 'p1',
        name: 'a'.repeat(100),
        description: 'b'.repeat(1000),
        created_at_ms: 0,
        updated_at_ms: 0,
      });

      await createChatProject(
        'user-1',
        { name: `  ${'a'.repeat(150)}  `, description: `  ${'b'.repeat(1500)}  ` },
        'tok',
      );

      const call = callConsoleChatProjectsProxy.mock.calls[0][0];
      expect(call.body.name).toBe('a'.repeat(100));
      expect(call.body.description).toBe('b'.repeat(1000));
    });
  });

  describe('getChatProject', () => {
    it('maps a found chat-project to the LibreChat shape', async () => {
      callConsoleChatProjectsProxy.mockResolvedValue({
        chat_project_id: 'p1',
        name: 'My Project',
        description: 'desc',
        created_at_ms: 0,
        updated_at_ms: 0,
      });
      const result = await getChatProject('user-1', 'p1', 'tok');
      expect(result).toMatchObject({ _id: 'p1', name: 'My Project', user: 'user-1' });
      expect(callConsoleChatProjectsProxy).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'GET', path: 'p1', token: 'tok' }),
      );
    });

    it('returns null on an invalid/missing projectId without calling the BFF', async () => {
      await expect(getChatProject('user-1', '', 'tok')).resolves.toBeNull();
      await expect(getChatProject('user-1', undefined, 'tok')).resolves.toBeNull();
      expect(callConsoleChatProjectsProxy).not.toHaveBeenCalled();
    });

    it('returns null on 404 (not found/not owned) — never throws', async () => {
      callConsoleChatProjectsProxy.mockRejectedValue(new SovereignMemoryError('nope', 404));
      await expect(getChatProject('user-1', 'missing', 'tok')).resolves.toBeNull();
    });

    it('propagates a non-404 error (fail-closed)', async () => {
      callConsoleChatProjectsProxy.mockRejectedValue(new SovereignMemoryError('boom', 502));
      await expect(getChatProject('user-1', 'p1', 'tok')).rejects.toMatchObject({ status: 502 });
    });
  });

  describe('listChatProjects', () => {
    it("lists the caller's own chat-projects, forwarding cursor/limit", async () => {
      callConsoleChatProjectsProxy.mockResolvedValueOnce({
        items: [
          { chat_project_id: 'p1', name: 'A', description: '', created_at_ms: 0, updated_at_ms: 0 },
        ],
        next_cursor: 'cursor-2',
      });

      const result = await listChatProjects('user-1', { cursor: 'c1', limit: 10 }, 'tok');

      expect(result.projects).toHaveLength(1);
      expect(result.projects[0]).toMatchObject({ _id: 'p1', name: 'A', user: 'user-1' });
      expect(result.nextCursor).toBe('cursor-2');
      expect(callConsoleChatProjectsProxy).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          path: '',
          query: { cursor: 'c1', limit: '10' },
        }),
      );
    });

    it('ignores sortBy/sortDirection/search — accepted but not forwarded (disclosed v1 simplification)', async () => {
      callConsoleChatProjectsProxy.mockResolvedValueOnce({ items: [], next_cursor: null });
      await listChatProjects(
        'user-1',
        { sortBy: 'name', sortDirection: 'asc', search: 'x' },
        'tok',
      );
      const call = callConsoleChatProjectsProxy.mock.calls[0][0];
      expect(call.query).toEqual({});
    });

    it('returns an empty page with nextCursor null when the caller has no chat-projects', async () => {
      callConsoleChatProjectsProxy.mockResolvedValueOnce({ items: [], next_cursor: null });
      await expect(listChatProjects('user-1', undefined, 'tok')).resolves.toEqual({
        projects: [],
        nextCursor: null,
      });
    });
  });

  describe('updateChatProject', () => {
    it('returns null on an invalid/missing projectId without calling the BFF', async () => {
      await expect(updateChatProject('user-1', '', { name: 'x' }, 'tok')).resolves.toBeNull();
      expect(callConsoleChatProjectsProxy).not.toHaveBeenCalled();
    });

    it('returns null when the existing chat-project is not found/not owned', async () => {
      callConsoleChatProjectsProxy.mockRejectedValueOnce(new SovereignMemoryError('nope', 404));
      await expect(
        updateChatProject('user-1', 'missing', { name: 'x' }, 'tok'),
      ).resolves.toBeNull();
    });

    it('FETCH-THEN-MERGE: updating only description preserves the existing name (upsert-only API, no PATCH)', async () => {
      callConsoleChatProjectsProxy
        .mockResolvedValueOnce({
          // existing-fetch
          chat_project_id: 'p1',
          name: 'Existing Name',
          description: 'old desc',
          created_at_ms: 0,
          updated_at_ms: 0,
        })
        .mockResolvedValueOnce({
          chat_project_id: 'p1',
          name: 'Existing Name',
          description: 'new desc',
          created_at_ms: 0,
          updated_at_ms: 1,
        });

      const result = await updateChatProject('user-1', 'p1', { description: 'new desc' }, 'tok');

      expect(result).toMatchObject({ name: 'Existing Name', description: 'new desc' });
      expect(callConsoleChatProjectsProxy).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          method: 'POST',
          body: { chat_project_id: 'p1', name: 'Existing Name', description: 'new desc' },
        }),
      );
    });

    it('rejects an explicit empty name update with a 400, without touching the existing row', async () => {
      callConsoleChatProjectsProxy.mockResolvedValueOnce({
        chat_project_id: 'p1',
        name: 'Existing Name',
        description: '',
        created_at_ms: 0,
        updated_at_ms: 0,
      });
      await expect(updateChatProject('user-1', 'p1', { name: '   ' }, 'tok')).rejects.toMatchObject(
        { status: 400 },
      );
      expect(callConsoleChatProjectsProxy).toHaveBeenCalledTimes(1);
    });
  });

  describe('deleteChatProject', () => {
    it('returns {deletedCount: 0, modifiedCount: 0} on an invalid/missing projectId without calling the BFF', async () => {
      await expect(deleteChatProject('user-1', '', 'tok')).resolves.toEqual({
        deletedCount: 0,
        modifiedCount: 0,
      });
      expect(callConsoleChatProjectsProxy).not.toHaveBeenCalled();
    });

    it('deletes and returns {deletedCount: 1, modifiedCount: 0} — modifiedCount always 0 (disclosed boundary)', async () => {
      callConsoleChatProjectsProxy.mockResolvedValue(undefined);
      const result = await deleteChatProject('user-1', 'p1', 'tok');
      expect(result).toEqual({ deletedCount: 1, modifiedCount: 0 });
      expect(callConsoleChatProjectsProxy).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'DELETE', path: 'p1', token: 'tok' }),
      );
    });

    it('tolerates a 404 (already deleted/not found) — idempotent, matches Mongo deletedCount:0 semantics', async () => {
      callConsoleChatProjectsProxy.mockRejectedValue(new SovereignMemoryError('gone', 404));
      await expect(deleteChatProject('user-1', 'p1', 'tok')).resolves.toEqual({
        deletedCount: 0,
        modifiedCount: 0,
      });
    });

    it('a non-404 delete error is fail-closed (propagates)', async () => {
      callConsoleChatProjectsProxy.mockRejectedValue(new SovereignMemoryError('boom', 502));
      await expect(deleteChatProject('user-1', 'p1', 'tok')).rejects.toMatchObject({
        status: 502,
      });
    });
  });

  describe('SOVEREIGN_METHOD_BINDERS — fixed positional arity, token always threaded through', () => {
    it('names exactly the five WIRED chat-project methods (assignConversationToProject and refreshChatProjectStats have NO entry)', () => {
      expect(Object.keys(SOVEREIGN_METHOD_BINDERS).sort()).toEqual([
        'createChatProject',
        'deleteChatProject',
        'getChatProject',
        'listChatProjects',
        'updateChatProject',
      ]);
    });

    it('each binder threads the given token through to the adapter call', async () => {
      callConsoleChatProjectsProxy.mockResolvedValue({
        chat_project_id: 'p1',
        name: 'n',
        description: '',
        created_at_ms: 0,
        updated_at_ms: 0,
      });
      await SOVEREIGN_METHOD_BINDERS.getChatProject('bound-token')('user-1', 'p1');
      expect(callConsoleChatProjectsProxy).toHaveBeenCalledWith(
        expect.objectContaining({ token: 'bound-token' }),
      );
    });
  });
});
