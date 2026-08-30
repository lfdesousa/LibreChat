/**
 * M3-WU-D2-3c — closes the memory-CONTEXT READ split-brain: under
 * `AUDITTRACE_MEMORY_BACKEND=sovereign`, agent memory WRITES already land in
 * the sovereign adapter (D2-3 Part B), but the chat-turn memory-CONTEXT
 * reads at 8 sites (`openai.js`, `responses.js`, `resume.js`, `client.js`)
 * still called `db.getFormattedMemories`/`db.getUserMemories` (the Mongo
 * model functions) directly, so a sovereign "remember this" write was
 * invisible to the same turn's own context.
 *
 * This is a SOURCE-LEVEL enumeration test, not a mocked-runtime test — the
 * four call-site files are large controllers with no existing unit-test
 * harness (`openai.js`/`responses.js`/`resume.js` have none at all;
 * `client.js`'s harness is exercised separately in
 * `client.memoryContextReads.sovereign.test.js`). Automating the "verified
 * by grep" audit Part B's own build record used by hand (see
 * `agentMethods.js`'s `resolveMemoryWriteMethods` JSDoc) turns a one-off
 * manual check into a mechanical regression guard: every occurrence of the
 * raw Mongo functions is confined to the ONE place it is allowed —
 * inside a `mongoMethods` fallback object passed INTO the seam
 * (`resolveMemoryMethods`/`resolveMemoryWriteMethods`), which itself decides
 * mongo-vs-sovereign by the flag. A regression that reintroduces a bare
 * `getFormattedMemories: db.getFormattedMemories` (or `getUserMemories:
 * db.getUserMemories`) passed DIRECTLY to a memory-context consumer
 * (`buildInlineMemoryContext`, `getRequestMemories`, or
 * `preflightResumeContent`'s dependencies) — bypassing the seam — makes
 * this test fail RED; confirmed by hand during the build (temporarily
 * reverting each site to the pre-D2-3c bare call), restored GREEN.
 */
const fs = require('fs');
const path = require('path');

const readSource = (filename) => fs.readFileSync(path.join(__dirname, filename), 'utf8');

/**
 * Strips every `mongoMethods: { ... }` object literal (the seam's own
 * mongo-fallback argument — the ONE place `db.getFormattedMemories`/
 * `db.getUserMemories` may legitimately appear as a bare reference,
 * including Part B's write-seam fallback, which this WU does not touch) out
 * of a source string, so whatever raw-Mongo references remain are exactly
 * the ones NOT routed through the seam.
 */
function stripMongoMethodsFallbacks(source) {
  // Flat (non-nested-brace) object literals only — true of every
  // `mongoMethods: { ... }` in these files; a nested-brace fallback would
  // silently escape this strip and is asserted against below as a guard on
  // the assertion's own validity.
  return source.replace(/mongoMethods:\s*\{[^{}]*\}/g, '');
}

describe('M3-WU-D2-3c — no residual Mongo memory-CONTEXT read under sovereign (enumeration)', () => {
  const files = ['openai.js', 'responses.js', 'resume.js', 'client.js'];

  it.each(files)(
    '%s: no `db.getFormattedMemories`/`db.getUserMemories` reference survives stripping every `mongoMethods` fallback object',
    (filename) => {
      const source = readSource(filename);
      // Sanity: this file actually contains at least one such reference in
      // its (allowed) mongoMethods fallback — otherwise the strip below
      // would pass vacuously (nothing to strip, nothing left to find).
      expect(source).toMatch(/mongoMethods:\s*\{[^{}]*(getFormattedMemories|getUserMemories)/);

      const stripped = stripMongoMethodsFallbacks(source);
      expect(stripped).not.toMatch(/db\.getFormattedMemories/);
      expect(stripped).not.toMatch(/db\.getUserMemories/);
    },
  );

  it('resume.js: the static `resumeContentProtectionDependencies.getUserMemories` (mongo) is OVERRIDDEN at the preflightResumeContent call site, not passed through bare', () => {
    const source = readSource('resume.js');
    const callStart = source.indexOf('preflightResumeContent(');
    const depsStart = source.indexOf('...resumeContentProtectionDependencies,', callStart);
    expect(depsStart).toBeGreaterThan(callStart);
    expect(source.slice(depsStart, depsStart + 500)).toMatch(
      /\.\.\.resumeContentProtectionDependencies,[\s\S]*getUserMemories:\s*resolveMemoryMethods\(/,
    );
    const callSite = source.slice(callStart, source.indexOf(');', depsStart) + 2);
    // The bare static object must NOT be the second (dependencies) argument
    // on its own — it must be spread into an override literal.
    expect(callSite).not.toMatch(
      /^\s*preflightResumeContent\(\s*\{[\s\S]*?\},\s*resumeContentProtectionDependencies,\s*\)/,
    );
  });

  it.each(['openai.js', 'responses.js'])(
    '%s: buildInlineMemoryContext receives the seam-resolved function, never `db.getFormattedMemories` directly',
    (filename) => {
      const source = readSource(filename);
      expect(source).toMatch(
        /const \{ getFormattedMemories: resolvedGetFormattedMemories \} = resolveMemoryMethods\(\{\s*\n\s*req,\s*\n\s*mongoMethods:\s*\{\s*getFormattedMemories:\s*db\.getFormattedMemories\s*\},\s*\n\s*\}\);/,
      );
      // Every buildInlineMemoryContext call must use the resolved variable.
      const calls = source.match(/buildInlineMemoryContext\(\{[\s\S]*?\}\);/g) || [];
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call).toMatch(/getFormattedMemories:\s*resolvedGetFormattedMemories/);
        expect(call).not.toMatch(/getFormattedMemories:\s*db\.getFormattedMemories/);
      }
    },
  );

  it('client.js: every getRequestMemories/db.getUserMemories read call resolves through resolveMemoryMethods, EXCEPT the frozen Part B write-seam block', () => {
    const source = readSource('client.js');

    // The 5 read sites this WU wires (Part B's own write-seam block at
    // `resolveMemoryWriteMethods({ ..., mongoMethods: { setMemory, deleteMemory,
    // getUserMemories: db.getUserMemories, getFormattedMemories: db.getFormattedMemories } })`
    // is excluded by the mongoMethods-fallback strip below, same as other files).
    const stripped = stripMongoMethodsFallbacks(source);
    expect(stripped).not.toMatch(/db\.getFormattedMemories/);
    expect(stripped).not.toMatch(/db\.getUserMemories/);

    // Positive assertion: `resolveMemoryMethods(` is actually CALLED at every
    // known read site, not just imported — one shared resolution for
    // `getAgentPartitionMemories`/`getCanonicalAgentMemories` (buildMessages)
    // plus one each for the `#useMemory` early-return branch, the post-write
    // keyed reload, and `getEventActorMemorySnapshots` — 4 call sites total.
    // Catches BOTH a reverted call site (bare `db.*` again) AND a silently
    // no-op wrapper (fewer call sites than known read paths).
    const callSites = (stripped.match(/resolveMemoryMethods\(/g) || []).length;
    expect(callSites).toBe(4);

    // The shared resolution's two destructured names must each be USED
    // (not just declared and discarded) at their respective read sites.
    const resolvedFormattedUses = (stripped.match(/resolvedGetFormattedMemories/g) || []).length;
    const resolvedUserUses = (stripped.match(/resolvedGetUserMemories/g) || []).length;
    expect(resolvedFormattedUses).toBeGreaterThanOrEqual(2); // declaration + >=1 use
    expect(resolvedUserUses).toBeGreaterThanOrEqual(2); // declaration + >=1 use (incl. the typeof guard)
  });
});
