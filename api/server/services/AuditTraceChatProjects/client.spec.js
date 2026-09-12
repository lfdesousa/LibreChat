jest.mock('axios');
jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

const axios = require('axios');
const { callConsoleChatProjectsProxy } = require('./client');
const { MissingAccessTokenError, SovereignMemoryError } = require('../AuditTraceMemory/errors');

describe('AuditTraceChatProjects/client — the BFF /console/chat-projects/* HTTP boundary', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  it('NEVER calls the BFF when no token is supplied — throws MissingAccessTokenError (401) locally', async () => {
    await expect(
      callConsoleChatProjectsProxy({ method: 'GET', path: '', token: null }),
    ).rejects.toThrow(MissingAccessTokenError);
    expect(axios.request).not.toHaveBeenCalled();
  });

  it('hits the base path with no trailing slash when path is empty (list/create)', async () => {
    process.env.AUDITTRACE_BFF_BASE_URL = 'http://bff.example.internal:8766';
    axios.request.mockResolvedValue({ status: 200, data: { items: [], next_cursor: null } });

    await callConsoleChatProjectsProxy({ method: 'GET', path: '', token: 'tok' });

    expect(axios.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: 'http://bff.example.internal:8766/console/chat-projects',
        headers: { Authorization: 'Bearer tok' },
      }),
    );
  });

  it('forwards the token and appends a non-empty path suffix', async () => {
    process.env.AUDITTRACE_BFF_BASE_URL = 'http://bff.example.internal:8766';
    axios.request.mockResolvedValue({ status: 200, data: { chat_project_id: 'p1' } });

    await callConsoleChatProjectsProxy({
      method: 'GET',
      path: 'p1',
      token: 'the-users-access-token',
    });

    expect(axios.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: 'http://bff.example.internal:8766/console/chat-projects/p1',
        headers: { Authorization: 'Bearer the-users-access-token' },
      }),
    );
  });

  it('returns the parsed response body on 2xx', async () => {
    axios.request.mockResolvedValue({ status: 201, data: { chat_project_id: 'p1' } });
    const result = await callConsoleChatProjectsProxy({
      method: 'POST',
      path: '',
      token: 't',
      body: {},
    });
    expect(result).toEqual({ chat_project_id: 'p1' });
  });

  it('normalizes an empty 204 body to undefined (a successful delete)', async () => {
    axios.request.mockResolvedValue({ status: 204, data: '' });
    const result = await callConsoleChatProjectsProxy({ method: 'DELETE', path: 'p1', token: 't' });
    expect(result).toBeUndefined();
  });

  it('relays a non-2xx BFF status byte-faithfully (fail-closed, no reinterpretation)', async () => {
    axios.request.mockResolvedValue({
      status: 403,
      data: { detail: 'forbidden' },
      statusText: 'Forbidden',
    });
    await expect(
      callConsoleChatProjectsProxy({ method: 'DELETE', path: 'p1', token: 't' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('relays a 404 as a 404 (never swallowed into a generic 500)', async () => {
    axios.request.mockResolvedValue({ status: 404, data: { detail: 'not found' } });
    await expect(
      callConsoleChatProjectsProxy({ method: 'GET', path: 'missing', token: 't' }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('maps a transport failure (BFF unreachable) to a 502, matching the BFF-side proxy discipline', async () => {
    axios.request.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(
      callConsoleChatProjectsProxy({ method: 'GET', path: '', token: 't' }),
    ).rejects.toMatchObject({ status: 502 });
  });

  it('every thrown error is a SovereignMemoryError so callers can branch on `.status` alone', async () => {
    axios.request.mockRejectedValue(new Error('boom'));
    await expect(
      callConsoleChatProjectsProxy({ method: 'GET', path: '', token: 't' }),
    ).rejects.toBeInstanceOf(SovereignMemoryError);
  });
});
