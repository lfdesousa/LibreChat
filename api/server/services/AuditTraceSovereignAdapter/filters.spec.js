/**
 * Unit tests for the pure filter-SHAPE helpers the adapter base's read/
 * write discipline hangs on. No I/O; every case here is a shape a live
 * call site (or a live REJECT) produced.
 */
const {
  isMongoSafeFilter,
  areMongoSafeArgs,
  idListFromValue,
  classifyFilter,
  narrowFilter,
  matchesExtraConstraints,
} = require('./filters');

const SHAPE = { idField: 'file_id', idAliases: ['_id'], ownerField: 'user' };

/** A stand-in for a Mongoose ObjectId (a real legacy `_id`). */
const fakeObjectId = () => ({ toHexString: () => 'a'.repeat(24) });

describe('AuditTraceSovereignAdapter/filters — pure shape classification', () => {
  describe('isMongoSafeFilter — the F6 predicate', () => {
    it('is false for anything Mongoose would strip-and-widen: undefined values, {}, non-objects', () => {
      expect(isMongoSafeFilter({ _id: undefined })).toBe(false);
      expect(isMongoSafeFilter({ file_id: 'x', user: undefined })).toBe(false);
      expect(isMongoSafeFilter({})).toBe(false);
      expect(isMongoSafeFilter(null)).toBe(false);
      expect(isMongoSafeFilter([])).toBe(false);
      expect(isMongoSafeFilter('x')).toBe(false);
    });

    it('is true for a defined-valued filter; null is a NARROWING value, not a strippable one', () => {
      expect(isMongoSafeFilter({ file_id: 'x' })).toBe(true);
      expect(isMongoSafeFilter({ tenantId: null })).toBe(true);
    });
  });

  describe('areMongoSafeArgs — the deferred-method guard', () => {
    it('flags a plain-object argument carrying an undefined value; tolerates empty options bags and primitives', () => {
      expect(areMongoSafeArgs([{ file_id: undefined }, 'x'])).toBe(false);
      expect(areMongoSafeArgs(['f1', {}])).toBe(true);
      expect(areMongoSafeArgs([null, undefined, 3])).toBe(true);
      expect(areMongoSafeArgs([{ file_id: 'f1', status: 'pending' }])).toBe(true);
    });
  });

  describe('idListFromValue', () => {
    it('normalizes a string, a {$in} set (deduped, non-empty strings only), and rejects the rest', () => {
      expect(idListFromValue('f1')).toEqual(['f1']);
      expect(idListFromValue({ $in: ['a', 'b', 'a', '', 3, null] })).toEqual(['a', 'b']);
      expect(idListFromValue({ $in: [] })).toEqual([]);
      expect(idListFromValue('')).toBeNull();
      expect(idListFromValue(null)).toBeNull();
      expect(idListFromValue(undefined)).toBeNull();
      expect(idListFromValue(42)).toBeNull();
      expect(idListFromValue({ $in: undefined })).toBeNull();
    });
  });

  describe('classifyFilter — by SHAPE, never by owner-key presence', () => {
    it('ids: a bare {file_id} with NO user key IS id-shaped (the owner split-brain shape)', () => {
      expect(classifyFilter({ file_id: 'f1' }, SHAPE)).toEqual({
        kind: 'ids',
        key: 'file_id',
        ids: ['f1'],
      });
    });

    it('ids: {file_id:{$in}} with or without user/extra keys — the user key changes NOTHING', () => {
      const withUser = classifyFilter(
        { user: 'u1', file_id: { $in: ['a', 'b'] }, height: { $exists: true } },
        SHAPE,
      );
      const withoutUser = classifyFilter({ file_id: { $in: ['a', 'b'] } }, SHAPE);
      expect(withUser).toEqual({ kind: 'ids', key: 'file_id', ids: ['a', 'b'] });
      expect(withoutUser).toEqual(withUser);
    });

    it('ids: an ALIAS key carrying a string ({_id: "<file_id>"}) is id-shaped under the alias key', () => {
      expect(classifyFilter({ _id: 'f1' }, SHAPE)).toEqual({
        kind: 'ids',
        key: '_id',
        ids: ['f1'],
      });
    });

    it('unsafe (F6): {_id: undefined} — the exact cross-user leak shape — is UNSAFE, never residual', () => {
      expect(classifyFilter({ _id: undefined }, SHAPE)).toEqual({ kind: 'unsafe' });
    });

    it('unsafe: {}, a non-object, an undefined-valued extra key, a present-but-empty id key', () => {
      expect(classifyFilter({}, SHAPE)).toEqual({ kind: 'unsafe' });
      expect(classifyFilter(null, SHAPE)).toEqual({ kind: 'unsafe' });
      expect(classifyFilter({ file_id: 'f1', user: undefined }, SHAPE)).toEqual({ kind: 'unsafe' });
      expect(classifyFilter({ file_id: null }, SHAPE)).toEqual({ kind: 'unsafe' });
      expect(classifyFilter({ file_id: '' }, SHAPE)).toEqual({ kind: 'unsafe' });
      expect(classifyFilter({ file_id: { $in: [] } }, SHAPE)).toEqual({ kind: 'unsafe' });
      expect(classifyFilter({ file_id: { $in: undefined } }, SHAPE)).toEqual({ kind: 'unsafe' });
      expect(classifyFilter({ file_id: 42 }, SHAPE)).toEqual({ kind: 'unsafe' });
    });

    it('residual: a REAL legacy Mongo ObjectId under the alias key is defined and addresses one row — deferred unchanged', () => {
      expect(classifyFilter({ _id: fakeObjectId() }, SHAPE)).toEqual({ kind: 'residual' });
    });

    it('own-list: no id key, owner key a non-empty string', () => {
      expect(classifyFilter({ user: 'u1' }, SHAPE)).toEqual({ kind: 'own-list' });
    });

    it('residual: no id key, no owner string (a TTL sweep / conversation-scoped shape)', () => {
      expect(classifyFilter({ expiredAt: { $ne: null } }, SHAPE)).toEqual({ kind: 'residual' });
      expect(classifyFilter({ user: '', context: 'x' }, SHAPE)).toEqual({ kind: 'residual' });
    });

    it('works with no aliases declared', () => {
      expect(
        classifyFilter({ _id: 'f1', user: 'u1' }, { idField: 'file_id', ownerField: 'user' }),
      ).toEqual({
        kind: 'own-list',
      });
    });
  });

  describe('narrowFilter', () => {
    it('swaps ONLY the id key to the missing set, preserving every other key', () => {
      const original = { user: 'u1', file_id: { $in: ['a', 'b', 'c'] }, height: { $exists: true } };
      expect(narrowFilter(original, 'file_id', ['b', 'c'])).toEqual({
        user: 'u1',
        file_id: { $in: ['b', 'c'] },
        height: { $exists: true },
      });
      expect(original.file_id).toEqual({ $in: ['a', 'b', 'c'] }); // not mutated
    });
  });

  describe('matchesExtraConstraints — client-side post-filter of sovereign rows', () => {
    const record = { file_id: 'f1', user: 'u1', height: 10, tenantId: null, context: 'agents' };

    it('applies equality, $in, $exists, $ne; skips the id key and aliases', () => {
      expect(matchesExtraConstraints(record, { file_id: 'zzz', user: 'u1' }, SHAPE)).toBe(true);
      expect(matchesExtraConstraints(record, { _id: 'zzz' }, SHAPE)).toBe(true);
      expect(matchesExtraConstraints(record, { user: 'other' }, SHAPE)).toBe(false);
      expect(matchesExtraConstraints(record, { height: { $exists: true } }, SHAPE)).toBe(true);
      expect(matchesExtraConstraints(record, { width: { $exists: true } }, SHAPE)).toBe(false);
      expect(matchesExtraConstraints(record, { width: { $exists: false } }, SHAPE)).toBe(true);
      expect(matchesExtraConstraints(record, { context: { $in: ['agents', 'x'] } }, SHAPE)).toBe(
        true,
      );
      expect(matchesExtraConstraints(record, { context: { $in: ['x'] } }, SHAPE)).toBe(false);
      expect(matchesExtraConstraints(record, { context: { $ne: 'agents' } }, SHAPE)).toBe(false);
      expect(matchesExtraConstraints(record, { context: { $ne: 'other' } }, SHAPE)).toBe(true);
    });

    it('null matches a null OR missing field (Mongo semantics); string/number equality is loose across types', () => {
      expect(matchesExtraConstraints(record, { tenantId: null }, SHAPE)).toBe(true);
      expect(matchesExtraConstraints(record, { missingField: null }, SHAPE)).toBe(true);
      expect(matchesExtraConstraints(record, { context: null }, SHAPE)).toBe(false);
      expect(matchesExtraConstraints(record, { height: '10' }, SHAPE)).toBe(true);
    });

    it('IGNORES unrecognized shapes (dotted paths, unknown operators, arrays) — never excludes on them', () => {
      expect(
        matchesExtraConstraints(record, { 'metadata.codeEnvRef': { $exists: true } }, SHAPE),
      ).toBe(true);
      expect(matchesExtraConstraints(record, { height: { $gt: 100 } }, SHAPE)).toBe(true);
      expect(matchesExtraConstraints(record, { tags: ['a'] }, SHAPE)).toBe(true);
    });
  });
});
