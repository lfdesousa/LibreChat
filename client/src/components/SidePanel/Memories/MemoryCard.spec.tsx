import { ToastProvider } from '@librechat/client';
import { render, screen } from '@testing-library/react';
import type { TUserMemory } from 'librechat-data-provider';
import MemoryCard from './MemoryCard';

/**
 * M3-WU-D2-3 Part A — the panel must never offer edit/delete for an entry
 * the adapter's `layer`/`readOnly` projection marks as un-writable, and it
 * must show which layer an entry lives in when the sovereign backend
 * projects one. Under the default `mongo` backend neither field is ever
 * present, so the card must render exactly as it did before this change.
 */

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useHasAccess: () => true,
  useClockFormat: () => true,
}));

jest.mock('~/data-provider', () => ({
  useDeleteMemoryMutation: () => ({ mutate: jest.fn(), isLoading: false }),
  useUpdateMemoryMutation: () => ({ mutate: jest.fn(), isLoading: false }),
  useMemoriesQuery: () => ({ data: { memories: [] } }),
}));

const baseMemory: TUserMemory = {
  key: 'favorite_language',
  value: 'TypeScript',
  updated_at: '2026-08-30T00:00:00.000Z',
};

const renderCard = (memory: TUserMemory, hasUpdateAccess = true) =>
  render(
    <ToastProvider>
      <MemoryCard memory={memory} hasUpdateAccess={hasUpdateAccess} />
    </ToastProvider>,
  );

describe('MemoryCard', () => {
  it('renders no layer badge and full actions for a plain mongo-backend entry (upstream parity)', () => {
    renderCard(baseMemory);

    expect(screen.queryByText('com_ui_memory_layer_semantic')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_ui_edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_ui_delete' })).toBeInTheDocument();
  });

  it('renders a layer badge and full actions for an editable sovereign entry', () => {
    renderCard({ ...baseMemory, layer: 'semantic', readOnly: false });

    expect(screen.getByText('com_ui_memory_layer_semantic')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_ui_edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_ui_delete' })).toBeInTheDocument();
  });

  /**
   * Non-vacuous guard (acceptance #1): withholding edit/delete for a
   * read-only entry is the whole point of this card. Neutering the
   * `!isReadOnly` gate in MemoryCard.tsx (e.g. changing `canManage` to
   * ignore `isReadOnly`) makes this test RED — verified by hand during the
   * build, restored, re-verified GREEN. See the build record.
   */
  it('withholds edit/delete for a read-only sovereign entry, but still shows its layer', () => {
    renderCard({ ...baseMemory, layer: 'conversational', readOnly: true });

    expect(screen.getByText(/com_ui_memory_layer_conversational/)).toBeInTheDocument();
    expect(screen.getByText(/com_ui_memory_read_only/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'com_ui_edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'com_ui_delete' })).not.toBeInTheDocument();
  });

  it('still withholds actions when the caller lacks update access, regardless of readOnly', () => {
    renderCard({ ...baseMemory, layer: 'semantic', readOnly: false }, false);

    expect(screen.queryByRole('button', { name: 'com_ui_edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'com_ui_delete' })).not.toBeInTheDocument();
  });

  it('renders no badge for a layer value it does not recognize', () => {
    renderCard({ ...baseMemory, layer: 'unknown_future_layer', readOnly: false });

    expect(screen.queryByText(/unknown_future_layer/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_ui_edit' })).toBeInTheDocument();
  });
});
