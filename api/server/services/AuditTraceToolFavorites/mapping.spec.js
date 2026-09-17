const {
  toLeanFavorite,
  deriveCompositeKey,
  apiToFavorite,
  favoriteAddBody,
  FAVORITE_KEY_SEPARATOR,
} = require('./mapping');

describe('toLeanFavorite', () => {
  it('keeps ONLY itemType/itemId — the exact Mongo lean projection', () => {
    expect(
      toLeanFavorite({
        itemType: 'mcp',
        itemId: 'x',
        user: 'lc-user-1',
        user_sub: 'sub-1',
        compositeKey: 'mcp:x',
      }),
    ).toEqual({ itemType: 'mcp', itemId: 'x' });
  });
});

describe('deriveCompositeKey', () => {
  it('joins itemType and itemId with the declared separator', () => {
    // Concrete expected string, not `` `tool${FAVORITE_KEY_SEPARATOR}dalle` ``
    // compared to itself — that form is a tautology that cannot fail no
    // matter what FAVORITE_KEY_SEPARATOR's value is (mirrors the lesson
    // from AuditTraceConversationTags/client.spec.js's own encodeTagPath
    // test, and this exact gap was caught by a manual neuter of
    // FAVORITE_KEY_SEPARATOR to '' during this WU's build-record proof
    // round — the tautological form stayed green under that neuter).
    expect(deriveCompositeKey('tool', 'dalle')).toBe('tool:dalle');
    expect(FAVORITE_KEY_SEPARATOR).toBe(':');
  });

  it('is collision-free across the closed itemType vocabulary even when itemId contains the separator', () => {
    // Every valid pairing, including adversarial itemIds that themselves
    // contain the separator, must derive a DISTINCT key from every other
    // pairing — the "itemId containing the separator is the obvious
    // attack" the spec calls out.
    const pairs = [
      ['builtin', 'web_search'],
      ['tool', 'dalle'],
      ['mcp', 'everything'],
      ['skill', 'abc123'],
      ['tool', 'mcp:everything'], // itemId embeds another valid itemType + separator
      ['mcp', 'tool:dalle'], // same, reversed
      ['skill', 'builtin:web_search'],
      ['builtin', 'skill:abc123'],
      ['tool', ':::'], // itemId that is ONLY separators
      ['mcp', ''.padEnd(0)], // degenerate but still a distinct pairing key-wise
    ];
    const keys = pairs.map(([itemType, itemId]) => deriveCompositeKey(itemType, itemId));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('never lets one pairing masquerade as another via the separator', () => {
    // (itemType='tool', itemId='mcp:evil') must NOT equal
    // (itemType='mcp', itemId='evil') even though naive string
    // concatenation could theoretically collide for other separators.
    const spoofAttempt = deriveCompositeKey('tool', 'mcp:evil');
    const target = deriveCompositeKey('mcp', 'evil');
    expect(spoofAttempt).not.toBe(target);
  });
});

describe('apiToFavorite', () => {
  it('maps snake_case wire fields to camelCase and stamps a compositeKey', () => {
    expect(
      apiToFavorite({
        item_type: 'mcp',
        item_id: 'everything',
        tenant_id: null,
        created_at_ms: 1,
        updated_at_ms: 2,
        deleted_at_ms: null,
        metadata: {},
      }),
    ).toEqual({
      itemType: 'mcp',
      itemId: 'everything',
      compositeKey: 'mcp:everything',
    });
  });
});

describe('favoriteAddBody', () => {
  it('builds the ConsoleToolFavoriteAddRequest body — item_type/item_id only, no owner/tenant/metadata fields', () => {
    expect(favoriteAddBody('mcp:everything', { itemType: 'mcp', itemId: 'everything' })).toEqual({
      item_type: 'mcp',
      item_id: 'everything',
    });
  });

  it('ignores the id parameter entirely — itemType/itemId always come from data', () => {
    const a = favoriteAddBody('SOME-OTHER-STRING', { itemType: 'tool', itemId: 'dalle' });
    const b = favoriteAddBody('mcp:everything', { itemType: 'tool', itemId: 'dalle' });
    expect(a).toEqual(b);
  });

  it('tolerates a nullish data argument (defensive default, never throws)', () => {
    expect(favoriteAddBody('mcp:everything', null)).toEqual({
      item_type: undefined,
      item_id: undefined,
    });
    expect(favoriteAddBody('mcp:everything', undefined)).toEqual({
      item_type: undefined,
      item_id: undefined,
    });
  });
});
