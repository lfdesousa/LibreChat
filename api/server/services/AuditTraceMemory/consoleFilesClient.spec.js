jest.mock('axios');
jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

const axios = require('axios');
const { logger } = require('@librechat/data-schemas');
const { callConsoleFilesProxy, SESSION_ID_PATTERN } = require('./consoleFilesClient');
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

  // ── LC-10a — the chat's conversation id rides as `X-Session-Id` ─────────
  describe('X-Session-Id (LC-10a): strip; empty means no header', () => {
    const call = async (sessionId) => {
      axios.post.mockResolvedValue({ status: 200, data: {} });
      await callConsoleFilesProxy({
        token: 't',
        filePath: '/tmp/x.txt',
        filename: 'x.txt',
        ...(sessionId === undefined ? {} : { sessionId }),
      });
      return axios.post.mock.calls[0][2].headers;
    };

    it('sends the conversation id as X-Session-Id, alongside (never instead of) Authorization', async () => {
      const headers = await call('0b1c2d3e-conv');
      expect(headers['X-Session-Id']).toBe('0b1c2d3e-conv');
      expect(headers.Authorization).toBe('Bearer t');
    });

    it('strips surrounding whitespace: " s1 " goes out as exactly "s1"', async () => {
      const headers = await call(' s1 ');
      expect(headers['X-Session-Id']).toBe('s1');
    });

    it.each([
      ['an empty string', ''],
      ['a whitespace-only string', '  '],
      ['a tab/newline-only string', '\t\n'],
      ['null', null],
      ['undefined (field absent: the first upload of a new chat)', undefined],
      ['a number', 123],
      ['an array (a repeated multipart field)', ['a', 'b']],
      ['an object', { id: 'a' }],
    ])('sends NO X-Session-Id header (not even an empty one) for %s', async (_label, value) => {
      const headers = await call(value);
      expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('x-session-id');
    });
  });

  // ── LC-10a AC-23 — the X-Session-Id shape, the SAME reject set as the memory server ──
  describe('X-Session-Id shape (AC-23): the memory server header_session_id reject set', () => {
    const call = async (sessionId) => {
      axios.post.mockResolvedValue({ status: 200, data: { status: 'uploaded' } });
      const result = await callConsoleFilesProxy({
        token: 't',
        filePath: '/tmp/x.txt',
        filename: 'x.txt',
        sessionId,
      });
      return { headers: axios.post.mock.calls[0][2].headers, result };
    };
    const hasHeader = (headers) =>
      Object.keys(headers).some((key) => key.toLowerCase() === 'x-session-id');

    it('pins the shape literal verbatim', () => {
      expect(SESSION_ID_PATTERN.source).toBe('^[\\x21-\\x7e]{1,255}$');
      expect(SESSION_ID_PATTERN.flags).toBe('');
    });

    it.each([
      ['256 characters', 'a'.repeat(256), 256],
      ['U+0000', '\u0000abc', 4],
      ['a trailing line feed', 'abc\n', 4],
      ['a leading line feed', '\nabc', 4],
      ['a CR/LF header injection', 'a\r\nX: 1', 7],
      ['a tab', 'a\tb', 3],
      ['U+00FF (not ASCII)', '\u00ff', 1],
      ['an inner space', 'a b', 3],
      ['an unresolved template opener {{', 'abc{{def', 8],
      ['an unresolved template closer }}', 'abc}}def', 8],
      ['a whole template placeholder', '{{LIBRECHAT_BODY_CONVERSATIONID}}', 33],
    ])(
      'rejects %s: no header, no throw, the upload resolves, a length-only warning',
      async (_label, value, length) => {
        const { headers, result } = await call(value);

        expect(hasHeader(headers)).toBe(false);
        expect(result).toEqual({ status: 'uploaded' });
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { length });
        expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(value.trim() || '\u0001');
      },
    );

    it.each([
      ['the shortest id', 'a', 'a'],
      ['255 characters', 'a'.repeat(255), 'a'.repeat(255)],
      ['a UUID', '0b1c2d3e-0000-4000-8000-000000000000', '0b1c2d3e-0000-4000-8000-000000000000'],
      ['surrounding spaces stripped', '  s1  ', 's1'],
      ['single braces are fine', '{a}', '{a}'],
      ['printable punctuation', '!~:_-.#', '!~:_-.#'],
    ])('accepts %s: exactly that value, no warning', async (_label, value, sent) => {
      const { headers } = await call(value);

      expect(headers['X-Session-Id']).toBe(sent);
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });
});
