/**
 * R21 v1 (ADDENDUM-1 B1), restored as extra coverage next to R21 v2 (`tokenReaders.pin.spec.js`, review r1 A3):
 * the dotted-form pin with its own, narrower allow-list. v2 allow-lists whole files (`env.ts`, `graph.ts`,
 * `obo.ts`, `openidStrategy.js`, ...); this pin has no entry for them, so a dotted reader added there still fails.
 * Neuter: add one direct `req.session.openidTokens.accessToken` reader outside the allow-list -> RED.
 */
const fs = require('fs');
const path = require('path');

/** api/ root of the tree under test (this spec lives at api/server/services/AuditTraceConversations/__tests__/). */
const API_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const REPO_ROOT = path.resolve(API_ROOT, '..');
const READER_RE =
  /openidTokens\??\.accessToken|federatedTokens\??\.access_token|openid_access_token/;
const ALLOWED = [
  'api/server/services/AuditTraceAuth/',
  'api/server/services/AuthService.js',
  'api/server/controllers/AuthController.js',
  'api/strategies/openIdJwtStrategy.js',
  'api/cache/banViolation.js', // clears the legacy cookie only
  'api/server/controllers/auth/LogoutController.js', // clears the legacy cookie only
  'packages/api/src/utils/oidc.ts',
  'packages/api/src/images/authorization.ts', // reads the refresh token for image cookies, not the access token
];
const isTestPath = (p) => /(\.spec\.|\.test\.|__tests__\/|__mocks__\/|wireProbe)/.test(p);
function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.'))
      continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(js|ts)$/.test(entry.name)) yield full;
  }
}
function directReaders() {
  const out = [];
  for (const root of [path.join(REPO_ROOT, 'api'), path.join(REPO_ROOT, 'packages/api/src')]) {
    for (const file of walk(root)) {
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
      if (isTestPath(rel) || ALLOWED.some((a) => rel.startsWith(a))) continue;
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '');
        if (/^\s*\*/.test(code)) return; // doc comments
        if (READER_RE.test(code)) out.push(`${rel}:${i + 1}`);
      });
    }
  }
  return out.sort();
}

describe('CONSOLE-LONG-TURN-TOKEN-REFRESH ADDENDUM-1 — the dotted reader pin (R21 v1)', () => {
  it('R21 — outside its allow-list no non-test file reads the access-token string through a dotted member', () => {
    expect(directReaders()).toEqual([]);
  });
});
