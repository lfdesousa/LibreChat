jest.mock('axios');
jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

const axios = require('axios');
const { callConsoleFilesProxy } = require('./consoleFilesClient');
const { MissingAccessTokenError, SovereignMemoryError } = require('./errors');

describe('AuditTraceMemory/consoleFilesClient — the BFF POST /console/files HTTP boundary (M3 WU-3)', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  it('NEVER calls the BFF when no token is supplied — throws MissingAccessTokenError (401) locally', async () => {
    await expect(
      callConsoleFilesProxy({ token: null, filePath: '/tmp/x.txt', filename: 'x.txt' }),
    ).rejects.toThrow(MissingAccessTokenError);
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('forwards the REAL user token as Authorization: Bearer to the configured BFF base URL, mints nothing', async () => {
    process.env.AUDITTRACE_BFF_BASE_URL = 'http://bff.example.internal:8766';
    axios.post.mockResolvedValue({ status: 200, data: { status: 'uploaded', layer: 'session' } });

    await callConsoleFilesProxy({
      token: 'the-users-real-oidc-access-token',
      filePath: '/tmp/x.txt',
      filename: 'x.txt',
      contentType: 'text/plain',
    });

    expect(axios.post).toHaveBeenCalledWith(
      'http://bff.example.internal:8766/console/files',
      expect.anything(),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer the-users-real-oidc-access-token',
        }),
      }),
    );
  });

  it('POSTs to /console/files, never /memory/upload directly and never RAG_API_URL', async () => {
    process.env.AUDITTRACE_BFF_BASE_URL = 'http://bff.example.internal:8766';
    axios.post.mockResolvedValue({ status: 200, data: {} });

    await callConsoleFilesProxy({ token: 't', filePath: '/tmp/x.txt', filename: 'x.txt' });

    const [calledUrl] = axios.post.mock.calls[0];
    expect(calledUrl).toBe('http://bff.example.internal:8766/console/files');
    expect(calledUrl).not.toMatch(/\/memory\//);
  });

  it('returns the BFF response body unchanged on 2xx', async () => {
    axios.post.mockResolvedValue({
      status: 200,
      data: { status: 'uploaded', layer: 'session', key: 'u1/session/x.txt', size_bytes: 3 },
    });
    const result = await callConsoleFilesProxy({
      token: 't',
      filePath: '/tmp/x.txt',
      filename: 'x.txt',
    });
    expect(result).toEqual({
      status: 'uploaded',
      layer: 'session',
      key: 'u1/session/x.txt',
      size_bytes: 3,
    });
  });

  it('relays a non-2xx BFF status byte-faithfully (fail-closed, no reinterpretation) — e.g. 400 PDF-to-session refusal', async () => {
    axios.post.mockResolvedValue({
      status: 400,
      data: { detail: 'PDF upload to layer=session is not supported' },
      statusText: 'Bad Request',
    });
    await expect(
      callConsoleFilesProxy({ token: 't', filePath: '/tmp/x.pdf', filename: 'x.pdf' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('relays a 403 (durable-layer rejection) as a 403, never swallowed into a generic 500', async () => {
    axios.post.mockResolvedValue({ status: 403, data: { detail: 'forbidden' } });
    await expect(
      callConsoleFilesProxy({ token: 't', filePath: '/tmp/x.txt', filename: 'x.txt' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('maps a transport failure (BFF unreachable) to a 502, matching the BFF-side proxy discipline', async () => {
    axios.post.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(
      callConsoleFilesProxy({ token: 't', filePath: '/tmp/x.txt', filename: 'x.txt' }),
    ).rejects.toMatchObject({ status: 502 });
  });

  it('every thrown error is a SovereignMemoryError so callers can branch on `.status` alone', async () => {
    axios.post.mockRejectedValue(new Error('boom'));
    await expect(
      callConsoleFilesProxy({ token: 't', filePath: '/tmp/x.txt', filename: 'x.txt' }),
    ).rejects.toBeInstanceOf(SovereignMemoryError);
  });
});
