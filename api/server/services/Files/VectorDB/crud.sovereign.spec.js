/**
 * M3 Sovereign-Attach WU-3 — the document-upload site (`uploadVectors`'s
 * embed seam) routes through the sovereign console-files adapter INSTEAD
 * of `${RAG_API_URL}/embed` when `AUDITTRACE_MEMORY_BACKEND=sovereign`,
 * and is BYTE-UNCHANGED (same `RAG_API_URL`/internal-JWT path) at its
 * `mongo` (unset/default) value — mirroring the `memories.js` /
 * `agentMethods.js` guard-at-top pattern (D2-2/D2-3c).
 *
 * Includes a source-level enumeration guard (mirrors
 * `memoryContextReads.sovereign.test.js`, D2-3c) that goes RED if the
 * sovereign branch reverts to a bare `${RAG_API_URL}/embed` call, or the
 * `isSovereignBackend()` guard stops early-returning before it — confirmed
 * by hand during the build: temporarily removing the guard made this
 * suite RED, restoring it made it GREEN again.
 */
const fs = require('fs');
const path = require('path');

jest.mock('axios');
jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));
jest.mock('@librechat/api', () => ({
  logAxiosError: jest.fn(),
  generateShortLivedToken: jest.fn(() => 'internal-librechat-jwt'),
}));
jest.mock('~/server/services/AuditTraceMemory/config', () => ({
  isSovereignBackend: jest.fn(() => false),
}));
jest.mock('~/server/services/AuditTraceMemory/consoleFilesClient', () => ({
  callConsoleFilesProxy: jest.fn(),
}));

const axios = require('axios');
const { generateShortLivedToken } = require('@librechat/api');
const { isSovereignBackend } = require('~/server/services/AuditTraceMemory/config');
const { callConsoleFilesProxy } = require('~/server/services/AuditTraceMemory/consoleFilesClient');
const {
  SovereignMemoryError,
  MissingAccessTokenError,
} = require('~/server/services/AuditTraceMemory/errors');
const { uploadVectors, uploadVectorsSovereign } = require('./crud');

const makeFile = (overrides = {}) => ({
  path: '/tmp/wu3-fixture.txt',
  originalname: 'notes.txt',
  mimetype: 'text/plain',
  size: 42,
  ...overrides,
});

const makeReq = (accessToken) => ({
  user: { id: 'user-1' },
  session: accessToken == null ? {} : { openidTokens: { accessToken } },
});

describe('VectorDB/crud — uploadVectors sovereign-backend routing (M3 WU-3)', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    jest.clearAllMocks();
    isSovereignBackend.mockReturnValue(false);
    process.env = { ...ORIGINAL_ENV };
  });

  // ── (a) sovereign upload forwards the OIDC token to /console/files,
  //        never to ${RAG_API_URL}/embed ─────────────────────────────
  it('under the sovereign backend, forwards the token to callConsoleFilesProxy and never calls RAG_API_URL/embed', async () => {
    isSovereignBackend.mockReturnValue(true);
    process.env.RAG_API_URL = 'http://rag-api.test'; // present but must be ignored
    callConsoleFilesProxy.mockResolvedValue({ status: 'uploaded', layer: 'session' });

    const req = makeReq('the-users-real-access-token');
    const file = makeFile();
    const result = await uploadVectors({ req, file, file_id: 'f1' });

    expect(callConsoleFilesProxy).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'the-users-real-access-token',
        filePath: file.path,
        filename: file.originalname,
        contentType: file.mimetype,
      }),
    );
    expect(axios.post).not.toHaveBeenCalled();
    expect(result).toEqual({
      bytes: file.size,
      filename: file.originalname,
      filepath: 'vectordb',
      embedded: true,
    });
  });

  // ── (b) forced-layer / narrow posture is the BFF's — the fork forwards
  //        the raw user token and mints NOTHING ──────────────────────
  it('under the sovereign backend, NEVER mints an internal short-lived JWT (that is the BFF/orchestrator posture, not ours)', async () => {
    isSovereignBackend.mockReturnValue(true);
    callConsoleFilesProxy.mockResolvedValue({ status: 'uploaded' });

    await uploadVectors({ req: makeReq('t'), file: makeFile(), file_id: 'f1' });

    expect(generateShortLivedToken).not.toHaveBeenCalled();
  });

  // ── (c) fail-closed: no token → propagates; BFF 4xx surfaced as-is ──
  it('propagates MissingAccessTokenError un-reinterpreted when the session carries no access token', async () => {
    isSovereignBackend.mockReturnValue(true);
    callConsoleFilesProxy.mockRejectedValue(new MissingAccessTokenError());

    await expect(
      uploadVectors({ req: makeReq(null), file: makeFile(), file_id: 'f1' }),
    ).rejects.toBeInstanceOf(MissingAccessTokenError);
    expect(callConsoleFilesProxy).toHaveBeenCalledWith(expect.objectContaining({ token: null }));
  });

  it('surfaces a BFF/orchestrator 4xx byte-faithfully (never retried, never reinterpreted, never a Mongo fallback)', async () => {
    isSovereignBackend.mockReturnValue(true);
    callConsoleFilesProxy.mockRejectedValue(
      new SovereignMemoryError(
        'sovereign console-files upload failed (400): PDF upload to layer=session is not supported',
        400,
      ),
    );

    await expect(
      uploadVectors({
        req: makeReq('t'),
        file: makeFile({ mimetype: 'application/pdf' }),
        file_id: 'f1',
      }),
    ).rejects.toMatchObject({ status: 400 });
    // Never falls back to the RAG/Mongo axios path on a BFF rejection.
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('surfaces a 403 (durable-layer rejection) byte-faithfully too', async () => {
    isSovereignBackend.mockReturnValue(true);
    callConsoleFilesProxy.mockRejectedValue(new SovereignMemoryError('forbidden', 403));

    await expect(
      uploadVectorsSovereign({ req: makeReq('t'), file: makeFile() }),
    ).rejects.toMatchObject({ status: 403 });
  });

  // ── (e) default (mongo) path byte-unchanged ─────────────────────────
  it('with the sovereign flag OFF (default), takes the UNCHANGED legacy ${RAG_API_URL}/embed path and never touches the adapter', async () => {
    isSovereignBackend.mockReturnValue(false);
    process.env.RAG_API_URL = 'http://rag-api.test';
    axios.post.mockResolvedValue({ status: 200, data: { status: true, known_type: true } });

    const req = makeReq('irrelevant-under-mongo');
    const file = makeFile();
    const result = await uploadVectors({ req, file, file_id: 'f1' });

    expect(generateShortLivedToken).toHaveBeenCalledWith('user-1');
    expect(axios.post).toHaveBeenCalledWith(
      'http://rag-api.test/embed',
      expect.anything(),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer internal-librechat-jwt' }),
      }),
    );
    expect(callConsoleFilesProxy).not.toHaveBeenCalled();
    expect(result).toEqual({
      bytes: file.size,
      filename: file.originalname,
      filepath: 'vectordb',
      embedded: true,
    });
  });

  it('with the sovereign flag OFF and RAG_API_URL unset, still throws the SAME "RAG_API_URL not defined" error as before', async () => {
    isSovereignBackend.mockReturnValue(false);
    delete process.env.RAG_API_URL;

    await expect(
      uploadVectors({ req: makeReq('t'), file: makeFile(), file_id: 'f1' }),
    ).rejects.toThrow('RAG_API_URL not defined');
    expect(callConsoleFilesProxy).not.toHaveBeenCalled();
  });

  // ── (d) source-enumeration guard (mirrors D2-3c) ────────────────────
  describe('source-enumeration guard — the sovereign branch cannot silently regress to a bare RAG_API_URL/embed call', () => {
    const extractFunctionBody = (source, signature) => {
      const startIdx = source.indexOf(signature);
      expect(startIdx).toBeGreaterThan(-1);
      // The signature's own param list is itself a destructured object
      // (`({ req, file, ... })`), which contains a `{` BEFORE the
      // function body's opening brace — skip past the param list's
      // closing `)` first so `bodyStart` lands on the body's brace, not
      // the destructuring's.
      const paramsCloseIdx = source.indexOf(')', startIdx);
      expect(paramsCloseIdx).toBeGreaterThan(-1);
      const bodyStart = source.indexOf('{', paramsCloseIdx);
      let depth = 0;
      let i = bodyStart;
      for (; i < source.length; i += 1) {
        if (source[i] === '{') {
          depth += 1;
        } else if (source[i] === '}') {
          depth -= 1;
          if (depth === 0) {
            break;
          }
        }
      }
      return source.slice(bodyStart, i + 1);
    };

    const readSource = () => fs.readFileSync(path.join(__dirname, 'crud.js'), 'utf8');

    it('uploadVectors: the sovereign guard PRECEDES the legacy RAG_API_URL/embed call and early-RETURNS before it', () => {
      const source = readSource();
      const body = extractFunctionBody(source, 'async function uploadVectors(');

      // Sanity: the legacy call is genuinely still present in this function
      // — otherwise the ordering assertion below would pass vacuously.
      expect(body).toMatch(/\$\{process\.env\.RAG_API_URL\}\/embed/);

      const guardIdx = body.indexOf('isSovereignBackend()');
      const embedIdx = body.indexOf('${process.env.RAG_API_URL}/embed');
      expect(guardIdx).toBeGreaterThan(-1);
      expect(guardIdx).toBeLessThan(embedIdx);

      const betweenGuardAndEmbed = body.slice(guardIdx, embedIdx);
      expect(betweenGuardAndEmbed).toMatch(/return uploadVectorsSovereign\(/);
    });

    it('uploadVectorsSovereign: calls the adapter, mints nothing, and never references RAG_API_URL at all', () => {
      const source = readSource();
      const body = extractFunctionBody(source, 'async function uploadVectorsSovereign(');

      expect(body).toMatch(/callConsoleFilesProxy\(/);
      expect(body).not.toMatch(/RAG_API_URL/);
      expect(body).not.toMatch(/generateShortLivedToken/);
    });
  });
});
