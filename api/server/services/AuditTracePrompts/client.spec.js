jest.mock('axios');
jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

const axios = require('axios');
const { callConsolePromptsProxy } = require('./client');
const { MissingAccessTokenError, SovereignMemoryError } = require('../AuditTraceMemory/errors');

describe('AuditTracePrompts/client — the BFF /console/prompts/* HTTP boundary', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  it('NEVER calls the BFF when no token is supplied — throws MissingAccessTokenError (401) locally', async () => {
    await expect(callConsolePromptsProxy({ method: 'GET', path: '', token: null })).rejects.toThrow(
      MissingAccessTokenError,
    );
    expect(axios.request).not.toHaveBeenCalled();
  });

  it('hits the base path with no trailing slash when path is empty (list/create)', async () => {
    process.env.AUDITTRACE_BFF_BASE_URL = 'http://bff.example.internal:8766';
    axios.request.mockResolvedValue({ status: 200, data: { items: [], next_cursor: null } });

    await callConsolePromptsProxy({ method: 'GET', path: '', token: 'tok' });

    expect(axios.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: 'http://bff.example.internal:8766/console/prompts',
        headers: { Authorization: 'Bearer tok' },
      }),
    );
  });

  it('forwards the token and appends a non-empty path suffix', async () => {
    process.env.AUDITTRACE_BFF_BASE_URL = 'http://bff.example.internal:8766';
    axios.request.mockResolvedValue({ status: 200, data: { group_id: 'g1' } });

    await callConsolePromptsProxy({
      method: 'GET',
      path: 'g1',
      token: 'the-users-access-token',
    });

    expect(axios.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: 'http://bff.example.internal:8766/console/prompts/g1',
        headers: { Authorization: 'Bearer the-users-access-token' },
      }),
    );
  });

  it('appends a nested path suffix (versions/production sub-resources)', async () => {
    process.env.AUDITTRACE_BFF_BASE_URL = 'http://bff.example.internal:8766';
    axios.request.mockResolvedValue({ status: 200, data: {} });

    await callConsolePromptsProxy({ method: 'POST', path: 'g1/versions', token: 't' });

    expect(axios.request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'http://bff.example.internal:8766/console/prompts/g1/versions',
      }),
    );
  });

  it('returns the parsed response body on 2xx', async () => {
    axios.request.mockResolvedValue({ status: 201, data: { group_id: 'g1' } });
    const result = await callConsolePromptsProxy({
      method: 'POST',
      path: '',
      token: 't',
      body: {},
    });
    expect(result).toEqual({ group_id: 'g1' });
  });

  it('relays a non-2xx BFF status byte-faithfully (fail-closed, no reinterpretation)', async () => {
    axios.request.mockResolvedValue({
      status: 403,
      data: { detail: 'forbidden' },
      statusText: 'Forbidden',
    });
    await expect(
      callConsolePromptsProxy({ method: 'DELETE', path: 'g1', token: 't' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('relays a 404 as a 404 (never swallowed into a generic 500)', async () => {
    axios.request.mockResolvedValue({ status: 404, data: { detail: 'not found' } });
    await expect(
      callConsolePromptsProxy({ method: 'GET', path: 'missing', token: 't' }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('maps a transport failure (BFF unreachable) to a 502, matching the BFF-side proxy discipline', async () => {
    axios.request.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(
      callConsolePromptsProxy({ method: 'GET', path: '', token: 't' }),
    ).rejects.toMatchObject({ status: 502 });
  });

  it('every thrown error is a SovereignMemoryError so callers can branch on `.status` alone', async () => {
    axios.request.mockRejectedValue(new Error('boom'));
    await expect(
      callConsolePromptsProxy({ method: 'GET', path: '', token: 't' }),
    ).rejects.toBeInstanceOf(SovereignMemoryError);
  });
});
