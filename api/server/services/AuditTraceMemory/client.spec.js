jest.mock('axios');
jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

const axios = require('axios');
const { callMemoryProxy } = require('./client');
const { MissingAccessTokenError, SovereignMemoryError } = require('./errors');

describe('AuditTraceMemory/client — the BFF /memory/* HTTP boundary', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  it('NEVER calls the BFF when no token is supplied — throws MissingAccessTokenError (401) locally', async () => {
    await expect(callMemoryProxy({ method: 'GET', path: 'episodic', token: null })).rejects.toThrow(
      MissingAccessTokenError,
    );
    expect(axios.request).not.toHaveBeenCalled();
  });

  it('forwards the token as Authorization: Bearer and hits the configured BFF base URL', async () => {
    process.env.AUDITTRACE_BFF_BASE_URL = 'http://bff.example.internal:8766';
    axios.request.mockResolvedValue({ status: 200, data: { items: [], total: 0 } });

    await callMemoryProxy({
      method: 'GET',
      path: 'semantic/librechat_personalization/timezone',
      token: 'the-users-access-token',
    });

    expect(axios.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: 'http://bff.example.internal:8766/memory/semantic/librechat_personalization/timezone',
        headers: { Authorization: 'Bearer the-users-access-token' },
      }),
    );
  });

  it('returns the parsed response body on 2xx', async () => {
    axios.request.mockResolvedValue({ status: 201, data: { id: 'abc', layer: 'semantic' } });
    const result = await callMemoryProxy({
      method: 'POST',
      path: 'semantic',
      token: 't',
      body: {},
    });
    expect(result).toEqual({ id: 'abc', layer: 'semantic' });
  });

  it('relays a non-2xx BFF status byte-faithfully (fail-closed, no reinterpretation)', async () => {
    axios.request.mockResolvedValue({
      status: 403,
      data: { detail: 'forbidden' },
      statusText: 'Forbidden',
    });
    await expect(
      callMemoryProxy({ method: 'PUT', path: 'episodic/x.md', token: 't' }),
    ).rejects.toMatchObject({
      status: 403,
    });
  });

  it('relays a 404 as a 404 (never swallowed into a generic 500)', async () => {
    axios.request.mockResolvedValue({ status: 404, data: { detail: 'not found' } });
    await expect(
      callMemoryProxy({ method: 'DELETE', path: 'procedural/x.md', token: 't' }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('maps a transport failure (BFF unreachable) to a 502, matching the BFF-side MemoryProxyError discipline', async () => {
    axios.request.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(
      callMemoryProxy({ method: 'GET', path: 'episodic', token: 't' }),
    ).rejects.toMatchObject({
      status: 502,
    });
  });

  it('every thrown error is a SovereignMemoryError so callers can branch on `.status` alone', async () => {
    axios.request.mockRejectedValue(new Error('boom'));
    await expect(
      callMemoryProxy({ method: 'GET', path: 'episodic', token: 't' }),
    ).rejects.toBeInstanceOf(SovereignMemoryError);
  });
});
