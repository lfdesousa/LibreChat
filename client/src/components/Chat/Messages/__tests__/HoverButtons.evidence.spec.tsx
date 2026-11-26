import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import { RecoilRoot, type MutableSnapshot } from 'recoil';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EModelEndpoint, type TConversation, type TMessage } from 'librechat-data-provider';
import HoverButtons from '~/components/Chat/Messages/HoverButtons';
import { initializeI18n } from '~/locales/i18n';
import store from '~/store';

/** The "Reconstruct this answer" affordance: assistant answers only, never while streaming. */

const mockUseEvidenceQuery = jest.fn();
jest.mock('~/data-provider/Evidence', () => ({
  useEvidenceQuery: (...args: unknown[]) => mockUseEvidenceQuery(...args),
}));

const conversation = {
  conversationId: 'convo-1',
  endpoint: EModelEndpoint.agents,
  title: 'Test',
} as TConversation;

const assistant = {
  messageId: 'assistant-1',
  conversationId: 'convo-1',
  parentMessageId: 'user-1',
  isCreatedByUser: false,
  text: 'an answer',
} as TMessage;

const user = { ...assistant, messageId: 'user-1', isCreatedByUser: true } as TMessage;

function renderButtons({
  message,
  isSubmitting = false,
}: {
  message: TMessage;
  isSubmitting?: boolean;
}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const initializeState = ({ set }: MutableSnapshot) => set(store.textToSpeech, false);
  return render(
    <QueryClientProvider client={queryClient}>
      <RecoilRoot initializeState={initializeState}>
        <MemoryRouter>
          <HoverButtons
            index={0}
            isLast
            isEditing={false}
            message={message}
            conversation={conversation}
            isSubmitting={isSubmitting}
            enterEdit={jest.fn()}
            regenerate={jest.fn()}
            handleContinue={jest.fn()}
            copyToClipboard={jest.fn()}
            getCanCopy={() => true}
            latestMessageId="assistant-1"
          />
        </MemoryRouter>
      </RecoilRoot>
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await initializeI18n();
});

beforeEach(() => {
  mockUseEvidenceQuery.mockReturnValue({ data: undefined, isLoading: true, isError: false });
});

describe('HoverButtons — Reconstruct this answer', () => {
  it('shows the button on a finished assistant message', () => {
    renderButtons({ message: assistant });
    expect(screen.getByRole('button', { name: 'Reconstruct this answer' })).toBeInTheDocument();
  });

  it('has no button on a user message', () => {
    renderButtons({ message: user });
    expect(
      screen.queryByRole('button', { name: 'Reconstruct this answer' }),
    ).not.toBeInTheDocument();
  });

  it('has no button while the answer is still streaming', () => {
    renderButtons({ message: assistant, isSubmitting: true });
    expect(
      screen.queryByRole('button', { name: 'Reconstruct this answer' }),
    ).not.toBeInTheDocument();
  });

  it('has no button on an errored message', () => {
    renderButtons({ message: { ...assistant, error: true } as TMessage });
    expect(
      screen.queryByRole('button', { name: 'Reconstruct this answer' }),
    ).not.toBeInTheDocument();
  });

  it('queries nothing until the button is clicked, then asks for this message id', async () => {
    renderButtons({ message: assistant });
    expect(mockUseEvidenceQuery).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Reconstruct this answer' }));
    expect(mockUseEvidenceQuery).toHaveBeenCalledWith('assistant-1', true);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
