import type { TUserMemory } from 'librechat-data-provider';
import {
  MEMORY_LAYER_FILTER_VALUES,
  getMemoryApiErrorMessage,
  getMemoryLayerLabelKey,
  hasSovereignLayerData,
} from './memory';

describe('getMemoryApiErrorMessage', () => {
  it('preserves an actionable server error', () => {
    const error = Object.assign(new Error('Request failed'), {
      response: { data: { error: 'Value exceeds the configured character limit.' } },
    });

    expect(getMemoryApiErrorMessage(error, 'Error')).toBe(
      'Value exceeds the configured character limit.',
    );
  });

  it('falls back when the server does not provide an error', () => {
    expect(getMemoryApiErrorMessage(new Error('Request failed'), 'Error')).toBe('Error');
  });
});

describe('getMemoryLayerLabelKey', () => {
  it('resolves a localization key for every filterable layer', () => {
    for (const layer of MEMORY_LAYER_FILTER_VALUES) {
      expect(getMemoryLayerLabelKey(layer)).toBe(`com_ui_memory_layer_${layer}`);
    }
  });

  it('returns null for a layer value it does not recognize', () => {
    expect(getMemoryLayerLabelKey('unknown_future_layer')).toBeNull();
  });
});

describe('hasSovereignLayerData', () => {
  const base: TUserMemory = { key: 'k', value: 'v', updated_at: '2026-08-30T00:00:00.000Z' };

  it('is false for undefined, an empty list, and mongo-backend entries', () => {
    expect(hasSovereignLayerData(undefined)).toBe(false);
    expect(hasSovereignLayerData([])).toBe(false);
    expect(hasSovereignLayerData([base, { ...base, key: 'k2' }])).toBe(false);
  });

  it('is true once at least one entry carries a layer', () => {
    expect(hasSovereignLayerData([base, { ...base, key: 'k2', layer: 'semantic' }])).toBe(true);
  });
});
