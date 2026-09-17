jest.mock('axios');
jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

const axios = require('axios');
const { callConsoleConversationTagsProxy, encodeTagPath } = require('./client');
const { MissingAccessTokenError, SovereignMemoryError } = require('../AuditTraceMemory/errors');

describe('AuditTraceConversationTags/client — encodeTagPath', () => {
  it('encodes a plain tag as one segment', () => {
    // Concrete expected string, not `encodeURIComponent(x)` compared to
    // itself (2026-09-17 review reject F1/R3: the ORIGINAL version of this
    // test asserted `encodeTagPath(x)).toBe(encodeURIComponent(x))` for
    // EVERY case including this one — a tautology that cannot fail for any
    // input and let the `.`/`..` defect through unnoticed.
    expect(encodeTagPath('work')).toBe('work');
  });

  it('percent-encodes special characters within a segment', () => {
    // 'a b?c#d' has no `/` — one segment — so `encodeURIComponent` alone
    // (never through the `isDotSegment` guard) IS the correct model here;
    // pinned against the concrete encoded string, not derived from the
    // function under test.
    expect(encodeTagPath('a b?c#d')).toBe('a%20b%3Fc%23d');
  });

  it('preserves a literal slash as a segment boundary, encoding each segment', () => {
    expect(encodeTagPath('project/sub tag')).toBe('project/sub%20tag');
  });

  it('leaves a segment that merely CONTAINS a dot alone (only a `.`/`..` SEGMENT is refused)', () => {
    expect(encodeTagPath('v1.2.3')).toBe('v1.2.3');
    expect(encodeTagPath('a.b/c..d')).toBe('a.b/c..d');
  });

  it('refuses a "." segment — fail-closed, before any network hop (F1)', () => {
    expect(() => encodeTagPath('.')).toThrow(SovereignMemoryError);
    expect(() => encodeTagPath('.')).toThrow(/would escape the conversation-tags path/);
  });

  it('refuses a ".." segment wherever it appears — leading, trailing, or nested (F1)', () => {
    expect(() => encodeTagPath('..')).toThrow(SovereignMemoryError);
    expect(() => encodeTagPath('../../console/files/victim-id')).toThrow(SovereignMemoryError);
    expect(() => encodeTagPath('project/../escape')).toThrow(SovereignMemoryError);
    expect(() => encodeTagPath('escape/..')).toThrow(SovereignMemoryError);
  });

  it('refuses ".." regardless of how many other segments surround it', () => {
    expect(() => encodeTagPath('a/../../b')).toThrow(SovereignMemoryError);
  });

  it('the thrown error carries a 400 status, distinguishing "refused locally" from any upstream status', () => {
    expect(() => encodeTagPath('..')).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe('AuditTraceConversationTags/client — the BFF /console/conversation-tags/* HTTP boundary', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  it('NEVER calls the BFF when no token is supplied — throws MissingAccessTokenError (401) locally', async () => {
    await expect(
      callConsoleConversationTagsProxy({ method: 'GET', path: '', token: null }),
    ).rejects.toThrow(MissingAccessTokenError);
    expect(axios.request).not.toHaveBeenCalled();
  });

  it('NEVER calls the BFF for a path containing a ".."/"." segment — refused locally, fail-closed (F1)', async () => {
    process.env.AUDITTRACE_BFF_BASE_URL = 'http://bff.example.internal:8766';
    await expect(
      callConsoleConversationTagsProxy({
        method: 'DELETE',
        path: '../../console/files/victim-id',
        token: 't',
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(axios.request).not.toHaveBeenCalled();
  });

  it('hits the /console/conversation-tags base path with no trailing slash when path is empty', async () => {
    process.env.AUDITTRACE_BFF_BASE_URL = 'http://bff.example.internal:8766';
    axios.request.mockResolvedValue({ status: 200, data: { items: [], next_cursor: null } });

    await callConsoleConversationTagsProxy({ method: 'GET', path: '', token: 'tok' });

    expect(axios.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: 'http://bff.example.internal:8766/console/conversation-tags',
        headers: { Authorization: 'Bearer tok' },
      }),
    );
  });

  it('forwards the token and appends a plain tag as the path suffix, unescaped (no special characters)', async () => {
    process.env.AUDITTRACE_BFF_BASE_URL = 'http://bff.example.internal:8766';
    axios.request.mockResolvedValue({ status: 200, data: { tag: 'work' } });

    await callConsoleConversationTagsProxy({
      method: 'GET',
      path: 'work',
      token: 'the-users-access-token',
    });

    expect(axios.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: 'http://bff.example.internal:8766/console/conversation-tags/work',
        headers: { Authorization: 'Bearer the-users-access-token' },
      }),
    );
  });

  it('percent-encodes a tag with special characters, preserving a literal slash as multiple path segments', async () => {
    process.env.AUDITTRACE_BFF_BASE_URL = 'http://bff.example.internal:8766';
    axios.request.mockResolvedValue({ status: 200, data: {} });

    await callConsoleConversationTagsProxy({
      method: 'DELETE',
      path: 'project/my tag?',
      token: 't',
    });

    expect(axios.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'DELETE',
        url:
          'http://bff.example.internal:8766/console/conversation-tags/project/' +
          encodeURIComponent('my tag?'),
      }),
    );
  });

  it('returns the parsed response body on 2xx', async () => {
    axios.request.mockResolvedValue({ status: 201, data: { tag: 'work' } });
    const result = await callConsoleConversationTagsProxy({
      method: 'POST',
      path: '',
      token: 't',
      body: {},
    });
    expect(result).toEqual({ tag: 'work' });
  });

  it('normalizes an empty 204 body to undefined (a successful delete)', async () => {
    axios.request.mockResolvedValue({ status: 204, data: '' });
    const result = await callConsoleConversationTagsProxy({
      method: 'DELETE',
      path: 'work',
      token: 't',
    });
    expect(result).toBeUndefined();
  });

  it('relays a non-2xx BFF status byte-faithfully (fail-closed, no reinterpretation)', async () => {
    axios.request.mockResolvedValue({
      status: 403,
      data: { detail: 'forbidden' },
      statusText: 'Forbidden',
    });
    await expect(
      callConsoleConversationTagsProxy({ method: 'DELETE', path: 'work', token: 't' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('relays a 404 as a 404 (never swallowed into a generic 500)', async () => {
    axios.request.mockResolvedValue({ status: 404, data: { detail: 'not found' } });
    await expect(
      callConsoleConversationTagsProxy({ method: 'GET', path: 'missing', token: 't' }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('maps a transport failure (BFF unreachable) to a 502, matching the BFF-side proxy discipline', async () => {
    axios.request.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(
      callConsoleConversationTagsProxy({ method: 'GET', path: '', token: 't' }),
    ).rejects.toMatchObject({ status: 502 });
  });

  it('every thrown error is a SovereignMemoryError so callers can branch on `.status` alone', async () => {
    axios.request.mockRejectedValue(new Error('boom'));
    await expect(
      callConsoleConversationTagsProxy({ method: 'GET', path: '', token: 't' }),
    ).rejects.toBeInstanceOf(SovereignMemoryError);
  });
});
