/**
 * CONSOLE-AUDIT-EVIDENCE WU-D — the fork's evidence route (G16, G20c).
 *
 * The route is a pass-through: it reads the user's own access token off the session (the
 * `memories.js` pattern), validates the id with the chain's shared predicate, then GETs the BFF
 * `/console/evidence/*` route and relays status and body unchanged. These tests pin each guard so
 * that removing it turns one of them RED (the neuter table is in the build record).
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

const mockAxiosRequest = jest.fn();
jest.mock('axios', () => ({ request: (...args) => mockAxiosRequest(...args) }));

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => {
    req.user = { id: 'user-1', role: 'USER' };
    next();
  },
}));

const evidenceRouter = require('./audittraceEvidence');

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');
const readFixture = (name) => fs.readFileSync(path.join(FIXTURES, name));
const V3 = 'console-audit-evidence.fixture.v3.json';
const V3_IMAGE = 'console-audit-evidence.fixture.v3-image.json';

const TOKEN = 'session-access-token';
const BFF = 'http://bff.test:8766';

const buildApp = ({ accessToken = TOKEN } = {}) => {
  const app = express();
  app.use((req, _res, next) => {
    req.session = accessToken ? { openidTokens: { accessToken } } : {};
    next();
  });
  app.use('/api/audittrace/evidence', evidenceRouter);
  return app;
};

/**
 * A GET whose path is sent verbatim. supertest (WHATWG URL) collapses `.` / `..` / `%2e` segments
 * before the request leaves the client, so the dot-segment grid could never reach the route
 * through it; `http.get` does not normalise.
 */
const rawGet = (app, rawPath) =>
  new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      http
        .get(
          { host: '127.0.0.1', port: server.address().port, path: rawPath, agent: false },
          (res) => {
            res.resume();
            res.on('end', () => {
              server.closeAllConnections();
              server.close(() => resolve({ status: res.statusCode }));
            });
          },
        )
        .on('error', (err) => server.close(() => reject(err)));
    });
  });

describe('the committed fixtures are the frozen bytes (v3, v3-image)', () => {
  it('v3 has the sha the spec chain froze', () => {
    const sha = crypto.createHash('sha256').update(readFixture(V3)).digest('hex');
    expect(sha.startsWith('e444ce53dd0fe315')).toBe(true);
  });

  it('v3-image has the sha the spec chain froze', () => {
    const sha = crypto.createHash('sha256').update(readFixture(V3_IMAGE)).digest('hex');
    expect(sha.startsWith('2dae13bd8010ea6a')).toBe(true);
  });
});

describe('audittraceEvidence route', () => {
  const ORIGINAL_BASE = process.env.AUDITTRACE_BFF_BASE_URL;

  beforeEach(() => {
    process.env.AUDITTRACE_BFF_BASE_URL = BFF;
    mockAxiosRequest.mockReset();
  });

  afterEach(() => {
    if (ORIGINAL_BASE === undefined) {
      delete process.env.AUDITTRACE_BFF_BASE_URL;
    } else {
      process.env.AUDITTRACE_BFF_BASE_URL = ORIGINAL_BASE;
    }
  });

  describe('G16 — fail closed without a token', () => {
    it('answers 401 and never contacts the BFF when the session has no access token', async () => {
      const response = await request(buildApp({ accessToken: null })).get(
        '/api/audittrace/evidence/messages/abc',
      );
      expect(response.status).toBe(401);
      expect(mockAxiosRequest).not.toHaveBeenCalled();
    });

    it('does the same for the interaction route', async () => {
      const response = await request(buildApp({ accessToken: null })).get(
        '/api/audittrace/evidence/interactions/12',
      );
      expect(response.status).toBe(401);
      expect(mockAxiosRequest).not.toHaveBeenCalled();
    });
  });

  describe('the data path is the BFF evidence route, GET only, with the caller own token', () => {
    it('GETs /console/evidence/messages/<id> with exactly the Authorization header', async () => {
      mockAxiosRequest.mockResolvedValue({ status: 200, data: JSON.parse(readFixture(V3)) });
      const response = await request(buildApp()).get(
        '/api/audittrace/evidence/messages/00000000-0000-4000-8000-00000000000b',
      );
      expect(response.status).toBe(200);
      expect(mockAxiosRequest).toHaveBeenCalledTimes(1);
      const call = mockAxiosRequest.mock.calls[0][0];
      expect(call.method).toBe('GET');
      expect(call.url).toBe(
        `${BFF}/console/evidence/messages/00000000-0000-4000-8000-00000000000b`,
      );
      expect(call.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
      expect(call.data).toBeUndefined();
    });

    it('GETs /console/evidence/interactions/<id>', async () => {
      mockAxiosRequest.mockResolvedValue({ status: 200, data: JSON.parse(readFixture(V3)) });
      const response = await request(buildApp()).get('/api/audittrace/evidence/interactions/8550');
      expect(response.status).toBe(200);
      expect(mockAxiosRequest.mock.calls[0][0].url).toBe(
        `${BFF}/console/evidence/interactions/8550`,
      );
    });

    it('relays the v3 body unchanged', async () => {
      const fixture = JSON.parse(readFixture(V3));
      mockAxiosRequest.mockResolvedValue({ status: 200, data: fixture });
      const response = await request(buildApp()).get('/api/audittrace/evidence/messages/abc');
      expect(response.body).toEqual(fixture);
    });

    it('relays the v3-image body unchanged', async () => {
      const fixture = JSON.parse(readFixture(V3_IMAGE));
      mockAxiosRequest.mockResolvedValue({ status: 200, data: fixture });
      const response = await request(buildApp()).get('/api/audittrace/evidence/messages/abc');
      expect(response.body).toEqual(fixture);
    });

    it('does not expose any write verb', async () => {
      for (const verb of ['post', 'put', 'patch', 'delete']) {
        const response = await request(buildApp())[verb]('/api/audittrace/evidence/messages/abc');
        expect(response.status).toBe(404);
      }
      expect(mockAxiosRequest).not.toHaveBeenCalled();
    });
  });

  describe('upstream statuses are relayed, never reinterpreted', () => {
    it.each([401, 403, 404])('relays %i with the same status', async (status) => {
      mockAxiosRequest.mockResolvedValue({ status, data: { detail: 'upstream said no' } });
      const response = await request(buildApp()).get('/api/audittrace/evidence/messages/abc');
      expect(response.status).toBe(status);
    });

    it('answers unknown and not-yours with the same status and body (no existence oracle)', async () => {
      mockAxiosRequest.mockResolvedValue({ status: 404, data: { detail: 'Not Found' } });
      const unknown = await request(buildApp()).get('/api/audittrace/evidence/messages/unknown-1');
      const foreign = await request(buildApp()).get('/api/audittrace/evidence/messages/foreign-1');
      expect(unknown.status).toBe(foreign.status);
      expect(unknown.body).toEqual(foreign.body);
    });

    it('answers 502 when the BFF is unreachable', async () => {
      mockAxiosRequest.mockRejectedValue(new Error('connect ECONNREFUSED'));
      const response = await request(buildApp()).get('/api/audittrace/evidence/messages/abc');
      expect(response.status).toBe(502);
    });
  });

  describe('G20c — path confinement: a bad id never reaches the BFF', () => {
    const BAD_IDS = [
      '..',
      '.',
      '%2e%2e',
      '%2e',
      '..%2f..%2fx',
      'a%2Fb',
      'abc%0A',
      'a%0Ab',
      'x'.repeat(256),
      'a%20b',
      'a%00b',
    ];

    it.each(BAD_IDS)('rejects message id %j with 400 and no upstream call', async (id) => {
      const response = await rawGet(buildApp(), `/api/audittrace/evidence/messages/${id}`);
      expect(response.status).toBe(400);
      expect(mockAxiosRequest).not.toHaveBeenCalled();
    });

    it.each(['abc', '-1', '1.5', '0x1', '1e3', '12%0A', 'x'.repeat(30), '..'])(
      'rejects interaction id %j with 400 and no upstream call',
      async (id) => {
        const response = await rawGet(buildApp(), `/api/audittrace/evidence/interactions/${id}`);
        expect(response.status).toBe(400);
        expect(mockAxiosRequest).not.toHaveBeenCalled();
      },
    );

    it('accepts the longest legal id and the dotted ids the predicate allows', async () => {
      mockAxiosRequest.mockResolvedValue({ status: 200, data: {} });
      for (const id of ['x'.repeat(255), '...', 'a..b', 'a:b_c.d-e']) {
        const response = await request(buildApp()).get(`/api/audittrace/evidence/messages/${id}`);
        expect(response.status).toBe(200);
      }
      expect(mockAxiosRequest).toHaveBeenCalledTimes(4);
    });

    it('percent-encodes the id when it builds the BFF URL', async () => {
      mockAxiosRequest.mockResolvedValue({ status: 200, data: {} });
      await request(buildApp()).get('/api/audittrace/evidence/messages/a:b');
      expect(mockAxiosRequest.mock.calls[0][0].url).toBe(`${BFF}/console/evidence/messages/a%3Ab`);
    });
  });
});

describe('the route is mounted in both server entry points', () => {
  const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

  it.each(['index.js', 'experimental.js'])('%s mounts /api/audittrace/evidence', (file) => {
    expect(read(file)).toContain("app.use('/api/audittrace/evidence', routes.audittraceEvidence);");
  });

  it('routes/index.js exports it', () => {
    const source = read(path.join('routes', 'index.js'));
    expect(source).toContain("const audittraceEvidence = require('./audittraceEvidence');");
    expect(source).toMatch(/module\.exports = \{[\s\S]*\n {2}audittraceEvidence,/);
  });
});
