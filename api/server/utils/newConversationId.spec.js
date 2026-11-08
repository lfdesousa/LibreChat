const fs = require('fs');
const path = require('path');
const {
  CLIENT_REQUEST_ID_PATTERN,
  NEW_CONVERSATION_IDEMPOTENCY_NAMESPACE,
  deriveNewConversationId,
} = require('./newConversationId');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const NAMESPACE = 'd7f2518c-94b8-4fe8-97ad-2d4bdb2c9f43';

const PATTERN_COPIES = [
  'packages/api/src/stream/GenerationJobManager.ts',
  'packages/api/src/stream/implementations/InMemoryJobStore.ts',
  'packages/api/src/stream/implementations/RedisJobStore.ts',
];

/** Production source files under `dir` (no tests, no build output, no deps). */
function productionSources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'coverage', '__tests__', '__mocks__'].includes(entry.name)) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      productionSources(full, out);
    } else if (/\.(js|ts)$/.test(entry.name) && !/\.(spec|test)\.[jt]s$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('deriveNewConversationId (AC-21)', () => {
  it('matches the known-answer vector (uuidv5 of "u:s" under the namespace, py + npm agree)', () => {
    expect(NEW_CONVERSATION_IDEMPOTENCY_NAMESPACE).toBe(NAMESPACE);
    expect(deriveNewConversationId('u', 's')).toBe('2240435c-9302-5c0a-900c-28ee7f7cbe8c');
  });

  it('is user-scoped and order-sensitive: swapping user and seed derives another id', () => {
    expect(deriveNewConversationId('s', 'u')).not.toBe(deriveNewConversationId('u', 's'));
    expect(deriveNewConversationId('u2', 's')).not.toBe(deriveNewConversationId('u', 's'));
  });

  it('keeps the namespace literal in exactly one production file (single-site guard)', () => {
    const hits = [
      ...productionSources(path.join(REPO_ROOT, 'api')),
      ...productionSources(path.join(REPO_ROOT, 'packages/api/src')),
    ].filter((file) => fs.readFileSync(file, 'utf8').includes(NAMESPACE));
    expect(hits.map((file) => path.relative(REPO_ROOT, file))).toEqual([
      'api/server/utils/newConversationId.js',
    ]);
  });
});

describe('CLIENT_REQUEST_ID_PATTERN four-copy pin (AC-21b)', () => {
  const declaration = /const CLIENT_REQUEST_ID_PATTERN = (\/.+\/);/;

  it('the three packages/api copies are byte-equal to the shared helper', () => {
    for (const rel of PATTERN_COPIES) {
      const match = declaration.exec(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
      expect({ file: rel, literal: match && match[1] }).toEqual({
        file: rel,
        literal: `/${CLIENT_REQUEST_ID_PATTERN.source}/`,
      });
    }
  });

  it('request.js declares none of its own and imports the helper', () => {
    const source = fs.readFileSync(
      path.join(REPO_ROOT, 'api/server/controllers/agents/request.js'),
      'utf8',
    );
    expect(declaration.test(source)).toBe(false);
    expect(source).toContain("require('~/server/utils/newConversationId')");
  });
});
