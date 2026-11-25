/**
 * A source-text pin (named as such): every call that resolves the LLM request headers on the agent
 * path hands over the request's token source, so the per-request bearer reaches the outbound
 * fetch (AC-8). The behaviour is pinned by `headers.freshAuthorizationFetch.spec.ts`; this pin
 * catches the seam being cut. Neuter: drop one `tokenSource` argument -> RED naming the site.
 */
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/** The text of every `fn({ ... })` call, up to the closing `})` at the call's own indentation. */
const callBlocks = (text, fn) => {
  const blocks = [];
  const re = new RegExp(`^( *)[^\\n]*\\b${fn}\\(\\{`, 'gm');
  let m;
  while ((m = re.exec(text)) !== null) {
    const end = text.indexOf(`\n${m[1]}})`, m.index);
    blocks.push(text.slice(m.index, end + 1));
  }
  return blocks;
};

describe('the token source reaches the LLM header resolution', () => {
  it('createRun hands its `tokenSource` to resolveConfigHeaders', () => {
    const blocks = callBlocks(read('packages/api/src/agents/run.ts'), 'resolveConfigHeaders');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatch(/\btokenSource\b/);
  });

  it('the agent client passes the request token source to createRun (run + resume) and to the title headers', () => {
    const text = read('api/server/controllers/agents/client.js');
    const runs = callBlocks(text, 'createRun');
    const titleHeaders = callBlocks(text, 'resolveConfigHeaders');
    expect(runs.length + titleHeaders.length).toBe(3);
    for (const block of [...runs, ...titleHeaders]) {
      expect(block).toMatch(/tokenSource: getRequestTokenSource\(\)/);
    }
  });
});
