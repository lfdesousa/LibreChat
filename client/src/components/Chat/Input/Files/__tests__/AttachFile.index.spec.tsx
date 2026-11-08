import React from 'react';
import { render } from '@testing-library/react';
import AttachFile from '../AttachFile';
import FileFormChat from '../FileFormChat';

const mockUseFileHandlingNoChatContext = jest.fn((_params?: unknown, _state?: unknown) => ({
  handleFileChange: jest.fn(),
  abortUpload: jest.fn(),
}));

jest.mock('~/hooks', () => ({
  useFileHandlingNoChatContext: (params?: unknown, state?: unknown) =>
    mockUseFileHandlingNoChatContext(params, state),
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/hooks/useKeyboardShortcuts', () => ({
  useShortcutAriaKey: () => undefined,
  useShortcutHint: () => '',
}));

jest.mock('recoil', () => ({
  ...jest.requireActual('recoil'),
  useRecoilValue: () => 'ltr',
}));

jest.mock('~/store', () => ({ __esModule: true, default: { chatDirection: 'chatDirection' } }));

jest.mock('../FileRow', () => ({ __esModule: true, default: () => null }));

jest.mock('@librechat/client', () => ({
  FileUpload: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipAnchor: () => null,
  AttachmentIcon: () => null,
}));

describe('composer callers hand their pane index to the upload hook (LC-10a, S3)', () => {
  beforeEach(() => mockUseFileHandlingNoChatContext.mockClear());

  const common = {
    files: new Map(),
    setFiles: jest.fn(),
    setFilesLoading: jest.fn(),
    conversation: null,
  };

  it('AttachFile', () => {
    render(<AttachFile {...common} index={1} />);

    expect(mockUseFileHandlingNoChatContext).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ index: 1 }),
    );
  });

  it('FileFormChat', () => {
    render(<FileFormChat {...common} index={1} />);

    expect(mockUseFileHandlingNoChatContext).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ index: 1 }),
    );
  });
});
