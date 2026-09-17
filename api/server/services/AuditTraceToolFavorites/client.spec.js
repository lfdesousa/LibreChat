jest.mock('axios');
jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

const axios = require('axios');
const { callConsoleToolFavoritesProxy, encodeFavoritePath } = require('./client');
const { MissingAccessTokenError, SovereignMemoryError } = require('../AuditTraceMemory/errors');

describe('AuditTraceToolFavorites/client — encodeFavoritePath', () => {
  it('encodes a plain item_id as one segment', () => {
    expect(encodeFavoritePath('mcp/dalle')).toBe('mcp/dalle');
  });

  it('percent-encodes special characters within a segment', () => {
    expect(encodeFavoritePath('tool/a b?c#d')).toBe('tool/a%20b%3Fc%23d');
  });

  it('preserves a literal slash in item_id as a segment boundary, encoding each segment', () => {
    expect(encodeFavoritePath('mcp/server/sub tool')).toBe('mcp/server/sub%20tool');
  });

  it('leaves a segment that merely CONTAINS a dot alone (only a `.`/`..` SEGMENT is refused)', () => {
    expect(encodeFavoritePath('tool/v1.2.3')).toBe('tool/v1.2.3');
  });

  it('refuses a "." segment — fail-closed, before any network hop', () => {
    expect(() => encodeFavoritePath('.')).toThrow(SovereignMemoryError);
    expect(() => encodeFavoritePath('.')).toThrow(/would escape the tool-favorites path/);
  });

  it('refuses a ".." segment wherever it appears', () => {
    expect(() => encodeFavoritePath('..')).toThrow(SovereignMemoryError);
    expect(() => encodeFavoritePath('../../console/files/victim-id')).toThrow(SovereignMemoryError);
    expect(() => encodeFavoritePath('mcp/..')).toThrow(SovereignMemoryError);
  });

  it('the thrown error carries a 400 status', () => {
    expect(() => encodeFavoritePath('..')).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe('AuditTraceToolFavorites/client — the BFF /console/tool-favorites/* HTTP boundary', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  it('NEVER calls the BFF when no token is supplied — throws MissingAccessTokenError (401) locally', async () => {
    await expect(
      callConsoleToolFavoritesProxy({ method: 'GET', path: '', token: null }),
    ).rejects.toThrow(MissingAccessTokenError);
    expect(axios.request).not.toHaveBeenCalled();
  });

  it('NEVER calls the BFF for a path containing a ".."/"." segment — refused locally, fail-closed', async () => {
    process.env.AUDITTRACE_BFF_BASE_URL = 'http://bff.example.internal:8766';
    await expect(
      callConsoleToolFavoritesProxy({
        method: 'DELETE',
        path: '../../console/files/victim-id',
        token: 't',
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(axios.request).not.toHaveBeenCalled();
  });

  it('hits the /console/tool-favorites base path with no trailing slash when path is empty', async () => {
    process.env.AUDITTRACE_BFF_BASE_URL = 'http://bff.example.internal:8766';
    axios.request.mockResolvedValue({ status: 200, data: { items: [] } });

    await callConsoleToolFavoritesProxy({ method: 'GET', path: '', token: 'tok' });

    expect(axios.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: 'http://bff.example.internal:8766/console/tool-favorites',
        headers: { Authorization: 'Bearer tok' },
      }),
    );
  });

  it('forwards the token and appends "item_type/item_id" as the path suffix', async () => {
    process.env.AUDITTRACE_BFF_BASE_URL = 'http://bff.example.internal:8766';
    axios.request.mockResolvedValue({ status: 204, data: '' });

    await callConsoleToolFavoritesProxy({
      method: 'DELETE',
      path: 'mcp/everything',
      token: 'the-users-access-token',
    });

    expect(axios.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'DELETE',
        url: 'http://bff.example.internal:8766/console/tool-favorites/mcp/everything',
        headers: { Authorization: 'Bearer the-users-access-token' },
      }),
    );
  });

  it('percent-encodes an item_id with special characters, preserving a literal slash as multiple segments', async () => {
    process.env.AUDITTRACE_BFF_BASE_URL = 'http://bff.example.internal:8766';
    axios.request.mockResolvedValue({ status: 204, data: '' });

    await callConsoleToolFavoritesProxy({
      method: 'DELETE',
      path: 'mcp/my tool?',
      token: 't',
    });

    expect(axios.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'DELETE',
        url:
          'http://bff.example.internal:8766/console/tool-favorites/mcp/' +
          encodeURIComponent('my tool?'),
      }),
    );
  });

  it('sends the query string for a list call', async () => {
    process.env.AUDITTRACE_BFF_BASE_URL = 'http://bff.example.internal:8766';
    axios.request.mockResolvedValue({ status: 200, data: { items: [] } });

    await callConsoleToolFavoritesProxy({
      method: 'GET',
      path: '',
      token: 't',
      query: { limit: '100' },
    });

    expect(axios.request).toHaveBeenCalledWith(
      expect.objectContaining({ params: { limit: '100' } }),
    );
  });

  it('returns the parsed response body on 2xx', async () => {
    axios.request.mockResolvedValue({ status: 201, data: { item_type: 'tool', item_id: 'x' } });
    const result = await callConsoleToolFavoritesProxy({
      method: 'POST',
      path: '',
      token: 't',
      body: { item_type: 'tool', item_id: 'x' },
    });
    expect(result).toEqual({ item_type: 'tool', item_id: 'x' });
  });

  it('normalizes an empty 204 body to undefined (a successful delete)', async () => {
    axios.request.mockResolvedValue({ status: 204, data: '' });
    const result = await callConsoleToolFavoritesProxy({
      method: 'DELETE',
      path: 'mcp/everything',
      token: 't',
    });
    expect(result).toBeUndefined();
  });

  it('relays a 404 as a 404 (a genuine "not found" from the remove route)', async () => {
    axios.request.mockResolvedValue({ status: 404, data: { detail: 'tool favorite not found' } });
    await expect(
      callConsoleToolFavoritesProxy({ method: 'DELETE', path: 'mcp/missing', token: 't' }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('relays a 409 as a 409 (the cap-exceeded add) — the domain adapter re-shapes it, not this client', async () => {
    axios.request.mockResolvedValue({
      status: 409,
      data: { detail: 'maximum of 100 tool favorites reached' },
      statusText: 'Conflict',
    });
    await expect(
      callConsoleToolFavoritesProxy({ method: 'POST', path: '', token: 't', body: {} }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('relays a 405 as a 405 (a GET against the DELETE-only {item_type}/{item_id} path shape)', async () => {
    axios.request.mockResolvedValue({
      status: 405,
      data: { detail: 'Method Not Allowed' },
      statusText: 'Method Not Allowed',
    });
    await expect(
      callConsoleToolFavoritesProxy({ method: 'GET', path: 'mcp/everything', token: 't' }),
    ).rejects.toMatchObject({ status: 405 });
  });

  it('maps a transport failure (BFF unreachable) to a 502, matching the BFF-side proxy discipline', async () => {
    axios.request.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(
      callConsoleToolFavoritesProxy({ method: 'GET', path: '', token: 't' }),
    ).rejects.toMatchObject({ status: 502 });
  });

  it('every thrown error is a SovereignMemoryError so callers can branch on `.status` alone', async () => {
    axios.request.mockRejectedValue(new Error('boom'));
    await expect(
      callConsoleToolFavoritesProxy({ method: 'GET', path: '', token: 't' }),
    ).rejects.toBeInstanceOf(SovereignMemoryError);
  });
});
