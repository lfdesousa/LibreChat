import { createElement } from 'react';
import userEvent from '@testing-library/user-event';
import { ToastProvider, OGDialogTrigger } from '@librechat/client';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { TUserMemory } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import MemoryCreateDialog from './MemoryCreateDialog';

/**
 * M3-WU-D2-3 Part A — under the sovereign backend the create target is
 * always the adapter's editable `semantic` layer (the server accepts no
 * `layer` param in this pass, so there is nothing to pick from); the
 * dialog surfaces that as a hint, and a 403 the adapter bounces (a write
 * that slipped to a read-only/corpus target) must read inline, never as a
 * silent success.
 */

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useHasAccess: () => true,
}));

let mockMemories: TUserMemory[] = [];
let capturedOptions: { onSuccess?: () => void; onError?: (error: Error) => void } = {};
const mockCreateMutate = jest.fn();

jest.mock('~/data-provider', () => ({
  useMemoriesQuery: () => ({ data: { memories: mockMemories } }),
  useCreateMemoryMutation: (options: typeof capturedOptions) => {
    capturedOptions = options;
    return { mutate: mockCreateMutate, isLoading: false };
  },
}));

const Wrapper = ({ children }: { children: ReactNode }) =>
  createElement(ToastProvider, null, children);

const renderDialog = () =>
  render(
    <MemoryCreateDialog open={true} onOpenChange={jest.fn()}>
      <OGDialogTrigger asChild>
        <button type="button">{'open'}</button>
      </OGDialogTrigger>
    </MemoryCreateDialog>,
    { wrapper: Wrapper },
  );

const fillValidForm = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(screen.getByLabelText('com_ui_key'), 'favorite_language');
  await user.type(screen.getByLabelText('com_ui_value'), 'TypeScript');
};

describe('MemoryCreateDialog', () => {
  beforeEach(() => {
    mockMemories = [];
    mockCreateMutate.mockReset();
    capturedOptions = {};
  });

  it('shows no create-target hint under the default mongo backend (upstream parity)', () => {
    mockMemories = [{ key: 'a', value: 'b', updated_at: '2026-08-30T00:00:00.000Z' }];
    renderDialog();

    expect(screen.queryByText('com_ui_memory_create_target_hint')).not.toBeInTheDocument();
  });

  it('hints the editable target layer once the sovereign backend is active', () => {
    mockMemories = [
      { key: 'a', value: 'b', updated_at: '2026-08-30T00:00:00.000Z', layer: 'semantic' },
    ];
    renderDialog();

    expect(screen.getByText('com_ui_memory_create_target_hint')).toBeInTheDocument();
  });

  it('never offers a layer selector — there is exactly one create target', () => {
    mockMemories = [
      {
        key: 'a',
        value: 'b',
        updated_at: '2026-08-30T00:00:00.000Z',
        layer: 'conversational',
        readOnly: true,
      },
    ];
    renderDialog();

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  /**
   * Non-vacuous guard (acceptance #1): a 403 from the adapter (a write
   * that slipped to a read-only/corpus target) must render inline, not
   * just vanish into a toast. Neutering the `setApiError` call in
   * `onError` (or dropping the banner's JSX) makes this RED — verified by
   * hand during the build, restored, re-verified GREEN. See the build
   * record.
   */
  it('surfaces a 403 from the adapter as an inline error, never a silent success', async () => {
    const user = userEvent.setup();
    renderDialog();
    await fillValidForm(user);

    await user.click(screen.getByRole('button', { name: 'com_ui_create_memory' }));
    expect(mockCreateMutate).toHaveBeenCalledTimes(1);

    const forbidden = Object.assign(new Error('Forbidden'), {
      response: { status: 403, data: { error: 'This layer is read-only.' } },
    });
    act(() => capturedOptions.onError?.(forbidden));

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('This layer is read-only.');
    // Still open, still editable — never a silent success.
    expect(screen.getByLabelText('com_ui_key')).toBeInTheDocument();
  });

  it('clears the inline error and closes on a successful create', async () => {
    const user = userEvent.setup();
    const onOpenChange = jest.fn();
    render(
      <MemoryCreateDialog open={true} onOpenChange={onOpenChange}>
        <OGDialogTrigger asChild>
          <button type="button">{'open'}</button>
        </OGDialogTrigger>
      </MemoryCreateDialog>,
      { wrapper: Wrapper },
    );
    await fillValidForm(user);
    await user.click(screen.getByRole('button', { name: 'com_ui_create_memory' }));

    const forbidden = Object.assign(new Error('Forbidden'), {
      response: { status: 403, data: { error: 'This layer is read-only.' } },
    });
    act(() => capturedOptions.onError?.(forbidden));
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    act(() => capturedOptions.onSuccess?.());
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
