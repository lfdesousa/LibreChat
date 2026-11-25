/**
 * CONSOLE-LONG-TURN-TOKEN-REFRESH ADDENDUM-2 — A1 (gate r2): R21 widened. An ADDITION (destination
 * `…/__tests__/tokenReaders.pin.spec.js`): ADDENDUM-1's file keeps R22 and R23; its dotted-only R21 is superseded by R21 v2 here.
 *
 * Why the text check is complete (the argument the gate asked for): the access-token STRING can enter code only by
 *  (1) a member read of a container object (`req.session.openidTokens`, `user.federatedTokens`, the legacy `openid_access_token`
 *      cookie) — dotted, optional, bracket or destructured; every such statement names the container on the line of the read
 *      or on the line that opens a multi-line destructuring; a line naming a container is flagged unless EVERY mention is
 *      immediately followed by a read of a non-access member (refreshToken, idToken, lastRefreshedAt, expiresAt, userId,
 *      id_token, refresh_token, expires_at); a bare container mention (the object passed on whole) is flagged;
 *  (2) the oidc helpers that return or consume it (`extractOpenIDTokenInfo`, `createBearerAuthHeader`,
 *      `processOpenIDPlaceholders`, `OPENID_TOKEN_FIELDS`) — flagged by name wherever imported or called;
 *  (3) a parameter named by a caller that did (1) or (2) — covered because the caller is flagged.
 * Second instrument: the CODE-INDEX `ts:import` rows whose `names` carry the helpers (recorded in the measurements; today
 * exactly `packages/api/src/mcp/oauth/obo.ts`, `packages/api/src/utils/env.ts`, `packages/api/src/utils/graph.ts`) — R21b
 * pins that set by a text import scan with the same expected value (GREEN today: a guard, named as such).
 * RED today (R21): 6 readers. Neuter: `const { accessToken } = req.session.openidTokens` anywhere → RED.
 */
const fs = require('fs');
const path = require('path');

const API_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const REPO_ROOT = path.resolve(API_ROOT, '..');
const CONTAINERS = /openidTokens|federatedTokens|openid_access_token/;
const HELPERS =
  /extractOpenIDTokenInfo|createBearerAuthHeader|processOpenIDPlaceholders|OPENID_TOKEN_FIELDS/;
const NON_ACCESS =
  '(refreshToken|idToken|lastRefreshedAt|expiresAt|userId|id_token|refresh_token|expires_at)';
const NON_ACCESS_READ = new RegExp(
  `(openidTokens|federatedTokens)(\\?\\.|\\.)${NON_ACCESS}\\b|(openidTokens|federatedTokens)\\[['"]${NON_ACCESS}['"]\\]`,
  'g',
);
const ALLOWED = [
  'api/server/services/AuditTraceAuth/',
  'api/server/services/AuthService.js',
  'api/server/controllers/AuthController.js',
  'api/strategies/openIdJwtStrategy.js',
  'api/cache/banViolation.js',
  'api/server/controllers/auth/LogoutController.js',
  'packages/api/src/utils/oidc.ts',
  'packages/api/src/images/authorization.ts',
  'packages/api/src/auth/userDocCache.ts', // deletes openidTokens from a cached user doc
  'packages/api/src/utils/env.ts', // the LLM header path, covered by R19
  'packages/api/src/utils/graph.ts', // Graph OBO (Entra), not BFF-bound
  'packages/api/src/mcp/oauth/obo.ts', // MCP OBO, not BFF-bound (the chart sets no OIDC placeholder for MCP)
  'api/strategies/openidStrategy.js', // WRITER: builds federatedTokens at login (:840); caught by the widened pin, classified
  'packages/api/src/middleware/remoteAgentAuth.ts', // WRITER: builds federatedTokens for a remote-agent bearer (:490)
];
const HELPER_IMPORTERS_EXPECTED = [
  'packages/api/src/mcp/oauth/obo.ts',
  'packages/api/src/utils/env.ts',
  'packages/api/src/utils/graph.ts',
];
const isTestPath = (p) => /(\.spec\.|\.test\.|__tests__\/|__mocks__\/|wireProbe|\.d\.ts$)/.test(p);
function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.'))
      continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(js|ts)$/.test(entry.name)) yield full;
  }
}
function scan() {
  const readers = [];
  const helperImporters = new Set();
  for (const root of [path.join(REPO_ROOT, 'api'), path.join(REPO_ROOT, 'packages/api/src')]) {
    for (const file of walk(root)) {
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
      if (isTestPath(rel)) continue;
      const text = fs.readFileSync(file, 'utf8');
      // import blocks may span lines: `import {\n a,\n b\n} from '…'` — scan them as a whole, plus require() calls
      for (const block of text.match(
        /import\s*(?:type\s*)?\{[^}]*\}\s*from\s*['"][^'"]+['"]|import\s+[\w$]+\s+from\s*['"][^'"]+['"]|require\(['"][^'"]+['"]\)[^\n]*|const\s*\{[^}]*\}\s*=\s*require\([^)]*\)/g,
      ) || []) {
        if (HELPERS.test(block)) helperImporters.add(rel);
      }
      const lines = text.split('\n');
      lines.forEach((raw, i) => {
        const code = raw.replace(/\/\/.*$/, '');
        if (/^\s*\*/.test(code) || /^\s*\/\*/.test(code)) return;
        if (ALLOWED.some((a) => rel.startsWith(a))) return;
        const stripped = code.replace(NON_ACCESS_READ, '');
        if (CONTAINERS.test(stripped) || HELPERS.test(code)) readers.push(`${rel}:${i + 1}`);
      });
    }
  }
  return { readers: readers.sort(), helperImporters: [...helperImporters].sort() };
}

describe('CONSOLE-LONG-TURN-TOKEN-REFRESH ADDENDUM-2 — the widened reader pin', () => {
  it('R21 (v2) — outside the allow-list no non-test file reaches the access-token string: container mentions (dotted, bracket, destructured, whole-object) and helper names', () => {
    expect(scan().readers).toEqual([]);
  });
  it('R21b — the importers of the oidc token helpers are exactly the three known OBO/LLM-header modules (guard; GREEN today)', () => {
    expect(scan().helperImporters).toEqual(HELPER_IMPORTERS_EXPECTED);
  });
});
