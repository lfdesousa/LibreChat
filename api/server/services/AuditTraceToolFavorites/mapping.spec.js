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
    //
    // DISCLOSED (falsifiability): this test is NOT separator-falsifiable —
    // given today's prefix-free 4-word vocabulary (`builtin`/`tool`/`mcp`/
    // `skill`, none a colon-terminated prefix of another), every pairing
    // below stays distinct under ANY separator value, including the empty
    // string, because the leading itemType alone already discriminates
    // every row. It genuinely exercises "an itemId embedding another
    // itemType doesn't cause a collision" — a real property — but it
    // cannot detect a wrong/neutered `FAVORITE_KEY_SEPARATOR`. Only the
    // "joins itemType and itemId with the declared separator" test above
    // pins the separator's actual value.
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
    //
    // DISCLOSED (falsifiability): same as the test above — with today's
    // prefix-free vocabulary, `spoofAttempt` and `target` differ by their
    // leading itemType regardless of the separator's value, so this test
    // also cannot go RED under a `FAVORITE_KEY_SEPARATOR` neuter. It
    // exercises a genuinely distinct property (no cross-itemType spoof),
    // just not the separator's identity.
    const spoofAttempt = deriveCompositeKey('tool', 'mcp:evil');
    const target = deriveCompositeKey('mcp', 'evil');
    expect(spoofAttempt).not.toBe(target);
  });
});

describe('deriveCompositeKey — bound to the REAL FAVORITE_ITEM_TYPES export', () => {
  // Every collision-freedom test in this WU (here and in
  // index.spec.js/wireProbe.spec.js) mocks `FAVORITE_ITEM_TYPES` with a
  // hardcoded literal — none binds the actual `@librechat/data-schemas`
  // export. If upstream ever adds a real item type, or one that IS a
  // colon-terminated prefix of another, nothing else in this suite would
  // turn red (each mock would just keep matching itself). This block is
  // deliberately NOT mocked — `mapping.spec.js` never mocks
  // `@librechat/data-schemas`, so this require resolves the real module.
  const { FAVORITE_ITEM_TYPES: REAL_FAVORITE_ITEM_TYPES } = require('@librechat/data-schemas');

  it('the real vocabulary matches the literal every mock in this WU assumes', () => {
    expect(REAL_FAVORITE_ITEM_TYPES).toEqual(['builtin', 'tool', 'mcp', 'skill']);
  });

  it('no REAL itemType is a separator-terminated prefix of another — the collision-freedom precondition', () => {
    // This is the actual property the module docstring's collision-freedom
    // argument depends on. Checked against the LIVE export, not a mock —
    // if upstream ever violates it (e.g. adds `tool2` alongside `tool`,
    // making `tool:` a prefix of `tool2:`... no — checked the OTHER way:
    // a future type equal to `tool:x`-shaped would need the FULL
    // separator-terminated string to prefix another), this test fails.
    for (const a of REAL_FAVORITE_ITEM_TYPES) {
      for (const b of REAL_FAVORITE_ITEM_TYPES) {
        if (a === b) {
          continue;
        }
        expect(`${b}${FAVORITE_KEY_SEPARATOR}`.startsWith(`${a}${FAVORITE_KEY_SEPARATOR}`)).toBe(
          false,
        );
      }
    }
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
