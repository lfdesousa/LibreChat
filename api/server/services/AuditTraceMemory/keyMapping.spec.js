const {
  isReadOnly,
  buildCompositeKey,
  parseCompositeKey,
  parseSemanticNativeRef,
  resolveCreateTarget,
  DEFAULT_SEMANTIC_COLLECTION,
} = require('./keyMapping');

describe('AuditTraceMemory/keyMapping', () => {
  describe('buildCompositeKey / parseCompositeKey round trip', () => {
    it.each([
      ['episodic', 'ADR-001.md'],
      ['procedural', 'skill-name.md'],
      ['semantic', 'librechat_personalization/timezone'],
      ['conversational', 'session-abc-123'],
    ])('round-trips %s:%s losslessly', (layer, nativeRef) => {
      const composite = buildCompositeKey(layer, nativeRef);
      expect(parseCompositeKey(composite)).toEqual({ layer, nativeRef });
    });

    it('returns null for a key with no recognised layer prefix', () => {
      expect(parseCompositeKey('timezone')).toBeNull();
      expect(parseCompositeKey('bogus_layer:foo')).toBeNull();
    });

    it('returns null for a non-string or empty-native-ref key', () => {
      expect(parseCompositeKey(undefined)).toBeNull();
      expect(parseCompositeKey('episodic:')).toBeNull();
    });

    it('splits on the FIRST colon only — a semantic native_ref may itself contain one', () => {
      expect(parseCompositeKey('semantic:col:with:colons/doc')).toEqual({
        layer: 'semantic',
        nativeRef: 'col:with:colons/doc',
      });
    });
  });

  describe('parseSemanticNativeRef', () => {
    it('splits collection/document_id on the first slash', () => {
      expect(parseSemanticNativeRef('librechat_personalization/timezone')).toEqual({
        collection: 'librechat_personalization',
        documentId: 'timezone',
      });
    });

    it('preserves slashes inside the document id', () => {
      expect(parseSemanticNativeRef('col/a/b/c')).toEqual({
        collection: 'col',
        documentId: 'a/b/c',
      });
    });

    it('returns null with no slash at all, or a leading/trailing slash', () => {
      expect(parseSemanticNativeRef('no-slash-here')).toBeNull();
      expect(parseSemanticNativeRef('/leading')).toBeNull();
      expect(parseSemanticNativeRef('trailing/')).toBeNull();
    });
  });

  describe('isReadOnly — the console write guard', () => {
    it('is ALWAYS read-only for episodic, regardless of tier', () => {
      expect(isReadOnly({ layer: 'episodic', tier: 'private' })).toBe(true);
      expect(isReadOnly({ layer: 'episodic', tier: 'corpus' })).toBe(true);
    });

    it('is ALWAYS read-only for conversational, regardless of tier', () => {
      expect(isReadOnly({ layer: 'conversational', tier: 'private' })).toBe(true);
    });

    it('is read-only for ANY layer when the tier is corpus (the shared/audit pool)', () => {
      expect(isReadOnly({ layer: 'semantic', tier: 'corpus' })).toBe(true);
      expect(isReadOnly({ layer: 'procedural', tier: 'corpus' })).toBe(true);
    });

    it('is writable for semantic/procedural at the private tier', () => {
      expect(isReadOnly({ layer: 'semantic', tier: 'private' })).toBe(false);
      expect(isReadOnly({ layer: 'procedural', tier: 'private' })).toBe(false);
    });
  });

  describe('resolveCreateTarget', () => {
    it('defaults a bare key to the personalization semantic collection', () => {
      expect(resolveCreateTarget('timezone')).toEqual({
        layer: 'semantic',
        collection: DEFAULT_SEMANTIC_COLLECTION,
        documentId: 'timezone',
      });
    });

    it('honours an explicit procedural: prefix', () => {
      expect(resolveCreateTarget('procedural:my-skill.md')).toEqual({
        layer: 'procedural',
        filename: 'my-skill.md',
      });
    });

    it('honours an explicit semantic:collection/id prefix', () => {
      expect(resolveCreateTarget('semantic:custom_collection/my-doc')).toEqual({
        layer: 'semantic',
        collection: 'custom_collection',
        documentId: 'my-doc',
      });
    });

    it('never honours an episodic: or conversational: prefix as a create target — falls back to the default', () => {
      expect(resolveCreateTarget('episodic:ADR-999.md')).toEqual({
        layer: 'semantic',
        collection: DEFAULT_SEMANTIC_COLLECTION,
        documentId: 'episodic:ADR-999.md',
      });
      expect(resolveCreateTarget('conversational:session-1')).toEqual({
        layer: 'semantic',
        collection: DEFAULT_SEMANTIC_COLLECTION,
        documentId: 'conversational:session-1',
      });
    });
  });
});
