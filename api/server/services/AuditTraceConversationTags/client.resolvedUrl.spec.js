/**
 * The REAL-BOUNDARY regression test for the F1 path-traversal fix
 * (2026-09-17 review reject / ADDENDUM E R1, R3).
 *
 * **Why this file exists separately from `client.spec.js`.** The
 * pre-fix suite mocked `axios` wholesale and asserted the `url` STRING
 * handed to the mock — so the one step that actually produced the
 * defect (axios's node adapter resolving that string through WHATWG
 * `new URL(...)`, which normalises `..` dot segments BEFORE the request
 * is issued) was never exercised. A mock cannot fail on a resolution
 * step it never performs. This file therefore does the opposite on
 * purpose: it does NOT `jest.mock('axios')`, spins up a REAL
 * `http.createServer`, points the client's `AUDITTRACE_BFF_BASE_URL` at
 * it, and asserts what the SERVER actually received — `req.url`, i.e.
 * the wire path after axios's real URL resolution, through the REAL
 * `callConsoleConversationTagsProxy` binder. This is the "resolved-URL,
 * real server, real binder" test the addendum requires; every other
 * case in `client.spec.js` still legitimately mocks axios for units
 * that do not need the real network stack.
 *
 * **Non-vacuity (manually verified, not committed):** temporarily
 * reverting `encodeTagPath` to the pre-fix
 * `tag.split('/').map(encodeURIComponent).join('/')` (no `isDotSegment`
 * check) turns the "REFUSES" cases below RED — the malicious call
 * resolves and the server observes the ESCAPED path exactly as this
 * file's comments predict (e.g. `/console/files/victim-id`,
 * `/v1/chat/completions`) — before being restored `cmp`-byte-identical.
 * See the build record for the captured RED output.
 */

const http = require('http');
const { callConsoleConversationTagsProxy } = require('./client');

describe('AuditTraceConversationTags/client — resolved-URL boundary (real server, real binder, axios NOT mocked)', () => {
  const ORIGINAL_ENV = { ...process.env };
  let server;
  let baseUrl;
  let requests;

  beforeAll(() => {
    server = http.createServer((req, res) => {
      requests.push({ method: req.method, url: req.url });
      res.statusCode = 204;
      res.end();
    });
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  beforeEach(() => {
    requests = [];
    process.env.AUDITTRACE_BFF_BASE_URL = baseUrl;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('a plain tag resolves to the expected path on the real server (control case)', async () => {
    await callConsoleConversationTagsProxy({ method: 'DELETE', path: 'holiday', token: 't' });
    expect(requests).toEqual([{ method: 'DELETE', url: '/console/conversation-tags/holiday' }]);
  });

  it('a multi-segment tag (a literal "/" in the tag name) resolves as multiple segments (control case)', async () => {
    await callConsoleConversationTagsProxy({ method: 'GET', path: 'project/sub', token: 't' });
    expect(requests).toEqual([{ method: 'GET', url: '/console/conversation-tags/project/sub' }]);
  });

  it('REFUSES "../../console/files/victim-id" — the exact reject-report payload — before the server sees anything', async () => {
    await expect(
      callConsoleConversationTagsProxy({
        method: 'DELETE',
        path: '../../console/files/victim-id',
        token: "the-caller's-own-bearer-token",
      }),
    ).rejects.toMatchObject({ status: 400 });
    // Pre-fix, axios's URL resolution would have collapsed this to
    // `/console/files/victim-id` — OUTSIDE `/console/conversation-tags`
    // — and the real server below would have received it, carrying the
    // caller's bearer token. Post-fix: nothing reaches the wire at all.
    expect(requests).toEqual([]);
  });

  it('REFUSES "../../v1/chat/completions" — the second reject-report payload', async () => {
    await expect(
      callConsoleConversationTagsProxy({
        method: 'DELETE',
        path: '../../v1/chat/completions',
        token: 't',
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(requests).toEqual([]);
  });

  it('REFUSES a ".." segment even when it does not escape the BFF origin (defence-in-depth, not just cross-domain cases)', async () => {
    await expect(
      callConsoleConversationTagsProxy({ method: 'DELETE', path: 'project/../escape', token: 't' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(requests).toEqual([]);
  });

  it('REFUSES a lone "." segment', async () => {
    await expect(
      callConsoleConversationTagsProxy({ method: 'GET', path: '.', token: 't' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(requests).toEqual([]);
  });

  it('still resolves a tag that merely CONTAINS dots without being a dot segment (no over-refusal)', async () => {
    await callConsoleConversationTagsProxy({ method: 'GET', path: 'v1.2.3', token: 't' });
    expect(requests).toEqual([{ method: 'GET', url: '/console/conversation-tags/v1.2.3' }]);
  });
});
