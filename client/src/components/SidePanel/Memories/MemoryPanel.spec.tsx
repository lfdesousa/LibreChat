import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import type { TUserMemory } from 'librechat-data-provider';
import MemoryPanel from './MemoryPanel';

/**
 * M3-WU-D2-3 Part A — the layer filter is driven entirely by whether the
 * fetched entries carry a `layer` (the sovereign-adapter's projection,
 * M3-WU-D2-2). Under the default `mongo` backend no entry ever has one, so
 * the filter chrome must stay entirely absent — the panel renders
 * byte-equivalent to upstream (requirement 6).
 */

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAuthContext: () => ({ user: { id: 'user-1', role: 'USER' } }),
  useHasAccess: () => true,
  useClockFormat: () => true,
}));

let mockMemories: TUserMemory[] = [];

jest.mock('~/data-provider', () => ({
  useMemoriesQuery: () => ({
    data: { memories: mockMemories, totalTokens: 0, tokenLimit: null, usagePercentage: null },
    isLoading: false,
  }),
  useGetUserQuery: () => ({ data: { personalization: { memories: true } } }),
  useUpdateMemoryPreferencesMutation: () => ({ mutate: jest.fn(), isLoading: false }),
  useCreateMemoryMutation: () => ({ mutate: jest.fn(), isLoading: false }),
  useUpdateMemoryMutation: () => ({ mutate: jest.fn(), isLoading: false }),
  useDeleteMemoryMutation: () => ({ mutate: jest.fn(), isLoading: false }),
}));

const mongoMemories: TUserMemory[] = [
  { key: 'favorite_language', value: 'TypeScript', updated_at: '2026-08-30T00:00:00.000Z' },
  { key: 'favorite_editor', value: 'VS Code', updated_at: '2026-08-29T00:00:00.000Z' },
];

const sovereignMemories: TUserMemory[] = [
  {
    key: 'favorite_language',
    value: 'TypeScript',
    updated_at: '2026-08-30T00:00:00.000Z',
    layer: 'episodic',
    readOnly: false,
  },
  {
    key: 'favorite_editor',
    value: 'VS Code',
    updated_at: '2026-08-29T00:00:00.000Z',
    layer: 'semantic',
    readOnly: false,
  },
  {
    key: 'onboarding_chat',
    value: 'Summary of the first onboarding conversation.',
    updated_at: '2026-08-28T00:00:00.000Z',
    layer: 'conversational',
    readOnly: true,
  },
];

describe('MemoryPanel — layer filter', () => {
  afterEach(() => {
    mockMemories = [];
  });

  it('renders no layer filter under the default mongo backend (upstream parity)', () => {
    mockMemories = mongoMemories;
    render(<MemoryPanel />);

    expect(screen.queryByTestId('memory-layer-filter')).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('offers the fixed layer set once at least one entry carries a layer', async () => {
    mockMemories = sovereignMemories;
    render(<MemoryPanel />);

    const trigger = screen.getByTestId('memory-layer-filter');
    expect(trigger).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);

    const user = userEvent.setup();
    await user.click(trigger);
    for (const label of [
      'com_ui_memories_layer_all',
      'com_ui_memory_layer_episodic',
      'com_ui_memory_layer_semantic',
      'com_ui_memory_layer_procedural',
      'com_ui_memory_layer_conversational',
      'com_ui_memory_layer_corpus',
    ]) {
      expect(screen.getByRole('option', { name: label })).toBeInTheDocument();
    }
  });

  /**
   * Non-vacuous guard: filtering by a specific layer must actually narrow
   * the rendered list, not just show the dropdown. Neutering the filter
   * predicate in MemoryPanel.tsx (e.g. always returning `partitionMemories`
   * regardless of `activeLayer`) makes this RED — verified by hand during
   * the build, restored, re-verified GREEN. See the build record.
   */
  it('filters the rendered list down to the selected layer', async () => {
    mockMemories = sovereignMemories;
    render(<MemoryPanel />);

    const trigger = screen.getByTestId('memory-layer-filter');
    const user = userEvent.setup();
    await user.click(trigger);
    await user.click(screen.getByRole('option', { name: 'com_ui_memory_layer_semantic' }));

    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('favorite_editor')).toBeInTheDocument();
    expect(screen.queryByText('favorite_language')).not.toBeInTheDocument();
    expect(screen.queryByText('onboarding_chat')).not.toBeInTheDocument();
  });

  it('returns to the full list when "All layers" is reselected', async () => {
    mockMemories = sovereignMemories;
    render(<MemoryPanel />);

    const trigger = screen.getByTestId('memory-layer-filter');
    const user = userEvent.setup();
    await user.click(trigger);
    await user.click(screen.getByRole('option', { name: 'com_ui_memory_layer_conversational' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(1);

    await user.click(trigger);
    await user.click(screen.getByRole('option', { name: 'com_ui_memories_layer_all' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });
});
