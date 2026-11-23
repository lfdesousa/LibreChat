import en from '~/locales/en/translation.json';
import fr from '~/locales/fr/translation.json';

const keys = (resource: Record<string, string>) =>
  Object.keys(resource).filter((key) => key.startsWith('com_evidence_'));

describe('evidence strings', () => {
  it('has the same com_evidence_ keys in en and fr (non-empty)', () => {
    const enKeys = keys(en as Record<string, string>).sort();
    const frKeys = keys(fr as Record<string, string>).sort();
    expect(enKeys.length).toBeGreaterThan(20);
    expect(frKeys).toEqual(enKeys);
    for (const key of enKeys) {
      expect((fr as Record<string, string>)[key].trim()).not.toBe('');
    }
  });

  it('keeps interpolation placeholders identical across languages', () => {
    const placeholders = (text: string) => (text.match(/{{\w+}}/g) ?? []).sort();
    for (const key of keys(en as Record<string, string>)) {
      expect(placeholders((fr as Record<string, string>)[key])).toEqual(
        placeholders((en as Record<string, string>)[key]),
      );
    }
  });

  it('fixes the three integrity labels', () => {
    const resource = en as Record<string, string>;
    expect(resource.com_evidence_integrity_match).toBe('Integrity: match');
    expect(resource.com_evidence_integrity_mismatch).toBe('Integrity: mismatch');
    expect(resource.com_evidence_integrity_unavailable).toBe(
      'Integrity: not recorded for this row type',
    );
  });
});
