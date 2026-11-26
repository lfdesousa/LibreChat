/**
 * The frozen `audittrace.evidence.v1` fixtures (v3 and v3-image) the spec chain committed byte for
 * byte to the fork under `api/test/fixtures/`. The client specs read those same bytes, so the UI is
 * tested against the contract the server is tested against, never against a hand-written copy.
 * The sha256 prefixes are asserted: a drifted fixture fails here before any rendering test runs.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const FIXTURE_DIR = path.resolve(__dirname, '..', '..', 'api', 'test', 'fixtures');

const FROZEN: Record<string, string> = {
  'console-audit-evidence.fixture.v3.json': 'e444ce53dd0fe315',
  'console-audit-evidence.fixture.v3-image.json': '2dae13bd8010ea6a',
};

export function loadEvidenceFixture(name: string): any {
  const bytes = fs.readFileSync(path.join(FIXTURE_DIR, name));
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  if (!sha.startsWith(FROZEN[name])) {
    throw new Error(`fixture ${name} drifted from the frozen bytes (sha256 ${sha})`);
  }
  return JSON.parse(bytes.toString('utf8'));
}

export const evidenceV3 = (): any => loadEvidenceFixture('console-audit-evidence.fixture.v3.json');
export const evidenceV3Image = (): any =>
  loadEvidenceFixture('console-audit-evidence.fixture.v3-image.json');
