import { createElement } from 'react';
import { act, render, screen } from '@testing-library/react';
import { ToastProvider, OGDialogTrigger } from '@librechat/client';
import type { TUserMemory } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import MemoryEditDialog from './MemoryEditDialog';

/**
 * M3-WU-D2-3 Part A — `MemoryEditDialog` is a defensive second gate on top
 * of `MemoryCardActions` withholding its own trigger: even if it were
 * somehow reached for a read-only entry, it must fall back to view-only
 * (no editable fields, no Save button), and a 403 the update mutation
 * bounces off must surface inline.
 */

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useHasAccess: () => true,
  useClockFormat: () => true,
}));

let capturedOptions: { onSuccess?: () => void; onError?: (error: Error) => void } = {};
const mockUpdateMutate = jest.fn();

jest.mock('~/data-provider', () => ({
  useMemoriesQuery: () => ({ data: { memories: [] } }),
  useUpdateMemoryMutation: (options: typeof capturedOptions) => {
    capturedOptions = options;
    return { mutate: mockUpdateMutate, isLoading: false };
  },
}));

const editableMemory: TUserMemory = {
  key: 'favorite_language',
  value: 'TypeScript',
  updated_at: '2026-08-30T00:00:00.000Z',
  layer: 'semantic',
  readOnly: false,
};

const readOnlyMemory: TUserMemory = {
  key: 'onboarding_chat',
  value: 'Summary of the first onboarding conversation.',
  updated_at: '2026-08-28T00:00:00.000Z',
  layer: 'conversational',
  readOnly: true,
};

const Wrapper = ({ children }: { children: ReactNode }) =>
  createElement(ToastProvider, null, children);

const renderDialog = (memory: TUserMemory, onOpenChange: (open: boolean) => void = jest.fn()) =>
  render(
    <MemoryEditDialog memory={memory} open={true} onOpenChange={onOpenChange}>
      <OGDialogTrigger asChild>
        <button type="button">{'open'}</button>
      </OGDialogTrigger>
    </MemoryEditDialog>,
    { wrapper: Wrapper },
  );

describe('MemoryEditDialog', () => {
  beforeEach(() => {
    mockUpdateMutate.mockReset();
    capturedOptions = {};
  });

  it('is fully editable for a plain mongo-backend entry (upstream parity)', () => {
    renderDialog({
      key: 'favorite_language',
      value: 'TypeScript',
      updated_at: '2026-08-30T00:00:00.000Z',
    });

    expect(screen.getByText('com_ui_edit_memory')).toBeInTheDocument();
    expect(screen.getByLabelText('com_ui_key')).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'com_ui_save' })).toBeInTheDocument();
  });

  it('is fully editable for an editable sovereign entry', () => {
    renderDialog(editableMemory);

    expect(screen.getByText('com_ui_edit_memory')).toBeInTheDocument();
    expect(screen.getByLabelText('com_ui_key')).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'com_ui_save' })).toBeInTheDocument();
  });

  /**
   * Non-vacuous guard (acceptance #1, defense-in-depth): a read-only entry
   * must fall back to view-only even if the dialog is somehow reached.
   * Neutering `canEdit` to ignore `memory?.readOnly` makes this RED —
   * verified by hand during the build, restored, re-verified GREEN. See
   * the build record.
   */
  it('falls back to view-only for a read-only sovereign entry', () => {
    renderDialog(readOnlyMemory);

    expect(screen.getByText('com_ui_view_memory')).toBeInTheDocument();
    expect(screen.getByLabelText('com_ui_key')).toBeDisabled();
    expect(screen.getByLabelText('com_ui_value')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'com_ui_save' })).not.toBeInTheDocument();
  });

  it('surfaces a 403 from the adapter as an inline error, never a silent success', async () => {
    renderDialog(editableMemory);

    const forbidden = Object.assign(new Error('Forbidden'), {
      response: { status: 403, data: { error: 'This layer became read-only.' } },
    });
    act(() => capturedOptions.onError?.(forbidden));

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('This layer became read-only.');
    // Still open, still showing the edit form — never a silent success.
    expect(screen.getByText('com_ui_edit_memory')).toBeInTheDocument();
  });

  it('clears the inline error and closes on a successful save', async () => {
    const onOpenChange = jest.fn();
    renderDialog(editableMemory, onOpenChange);

    const forbidden = Object.assign(new Error('Forbidden'), {
      response: { status: 403, data: { error: 'This layer became read-only.' } },
    });
    act(() => capturedOptions.onError?.(forbidden));
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    act(() => capturedOptions.onSuccess?.());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
