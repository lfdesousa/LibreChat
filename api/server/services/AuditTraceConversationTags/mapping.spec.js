/**
 * Pure mapping tests for `AuditTraceConversationTags/mapping.js`. No I/O,
 * no mocks needed.
 */
const { isFiniteNumber, tagUpsertBody, apiToTag } = require('./mapping');

describe('AuditTraceConversationTags/mapping — isFiniteNumber', () => {
  it('is true only for finite numbers', () => {
    expect(isFiniteNumber(1)).toBe(true);
    expect(isFiniteNumber(0)).toBe(true);
    expect(isFiniteNumber(-3.5)).toBe(true);
    expect(isFiniteNumber(NaN)).toBe(false);
    expect(isFiniteNumber(Infinity)).toBe(false);
    expect(isFiniteNumber('1')).toBe(false);
    expect(isFiniteNumber(undefined)).toBe(false);
    expect(isFiniteNumber(null)).toBe(false);
  });
});

describe('AuditTraceConversationTags/mapping — tagUpsertBody', () => {
  it('builds the upsert body with defaults for a bare tag', () => {
    expect(tagUpsertBody('work', {})).toEqual({
      tag: 'work',
      description: undefined,
      count: 0,
      position: 0,
      metadata: {},
    });
  });

  it('carries description/count/position through when present and valid', () => {
    expect(tagUpsertBody('work', { description: 'my tag', count: 3, position: 2 })).toEqual({
      tag: 'work',
      description: 'my tag',
      count: 3,
      position: 2,
      metadata: {},
    });
  });

  it('clamps a negative count to 0 (the orchestrator rejects count<0 with a 422)', () => {
    expect(tagUpsertBody('work', { count: -5 })).toMatchObject({ count: 0 });
  });

  it('truncates a non-integer count/position rather than forwarding a float', () => {
    expect(tagUpsertBody('work', { count: 2.9, position: 3.2 })).toMatchObject({
      count: 2,
      position: 3,
    });
  });

  it('drops a non-string description and a non-finite count/position back to safe defaults', () => {
    expect(tagUpsertBody('work', { description: 42, count: 'x', position: null })).toEqual({
      tag: 'work',
      description: undefined,
      count: 0,
      position: 0,
      metadata: {},
    });
  });

  it('tolerates a null/undefined data argument', () => {
    expect(tagUpsertBody('work', null)).toEqual({
      tag: 'work',
      description: undefined,
      count: 0,
      position: 0,
      metadata: {},
    });
    expect(tagUpsertBody('work', undefined)).toEqual({
      tag: 'work',
      description: undefined,
      count: 0,
      position: 0,
      metadata: {},
    });
  });
});

describe('AuditTraceConversationTags/mapping — apiToTag', () => {
  it('maps a store row onto the LibreChat shape, with _id = tag and NO owner field', () => {
    const mapped = apiToTag({
      tag: 'work',
      description: 'my tag',
      count: 4,
      position: 1,
      created_at_ms: 1700000000000,
      updated_at_ms: 1700000001000,
      deleted_at_ms: null,
      metadata: {},
    });
    expect(mapped).toEqual({
      _id: 'work',
      tag: 'work',
      description: 'my tag',
      position: 1,
      count: 4,
      createdAt: new Date(1700000000000),
    });
    expect('user' in mapped).toBe(false);
    expect('user_sub' in mapped).toBe(false);
  });

  it('defaults description/createdAt to undefined and count/position to 0 for a malformed row', () => {
    const mapped = apiToTag({ tag: 'bare' });
    expect(mapped).toEqual({
      _id: 'bare',
      tag: 'bare',
      description: undefined,
      position: 0,
      count: 0,
      createdAt: undefined,
    });
  });
});
