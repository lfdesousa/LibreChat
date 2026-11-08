import { renderHook, act } from '@testing-library/react';
import { Constants, mergeFileConfig } from 'librechat-data-provider';
import { clearNewChatSeed, mintNewChatSeed, peekNewChatSeed } from '~/utils';

/** Mirrors a browser that can (or cannot) decode the bytes it was handed. */
let mockImageDecodes = true;

beforeAll(() => {
  global.URL.createObjectURL = jest.fn(() => 'blob:mock-url');
  global.URL.revokeObjectURL = jest.fn();
  Object.defineProperty(global, 'Image', {
    writable: true,
    value: class {
      width = 640;
      height = 480;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_src: string) {
        queueMicrotask(() => (mockImageDecodes ? this.onload?.() : this.onerror?.()));
      }
    },
  });
});

const mockShowToast = jest.fn();
const mockSetFilesLoading = jest.fn();
const mockMutate = jest.fn();
const mockProcessFileForUpload = jest.fn(
  async (_file: File, _quality?: number, _onProgress?: (progress: number) => void) => _file,
);
const mockResizeImageIfNeeded = jest.fn(async (file: File) => ({ file, resized: false }));
const mockWaitForConfig = jest.fn((): Promise<void> => Promise.resolve());
const mockLocalize = jest.fn((key: string) => key);

let mockConversation: Record<string, string | null | undefined> = {};
let mockFileConfig: ReturnType<typeof mergeFileConfig> | null = null;
let mockIsConfigPending = false;
let mockChatIndex = 0;
let mockIsTemporary = false;

jest.mock('~/Providers/ChatContext', () => ({
  useChatContext: jest.fn(() => ({
    files: new Map(),
    setFiles: jest.fn(),
    setFilesLoading: mockSetFilesLoading,
    conversation: mockConversation,
    index: mockChatIndex,
  })),
}));

jest.mock('@librechat/client', () => ({
  useToastContext: jest.fn(() => ({
    showToast: mockShowToast,
  })),
}));

jest.mock('recoil', () => ({
  ...jest.requireActual('recoil'),
  useSetRecoilState: jest.fn(() => jest.fn()),
  useRecoilValue: jest.fn(() => mockIsTemporary),
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: { isTemporary: { key: 'isTemporary' } },
  ephemeralAgentByConvoId: jest.fn(() => ({ key: 'mock' })),
}));

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: jest.fn(() => ({
    getQueryData: jest.fn(),
    refetchQueries: jest.fn(),
  })),
}));

jest.mock('~/data-provider', () => ({
  useGetFileConfig: jest.fn(() => ({ data: mockFileConfig })),
  useUploadFileMutation: jest.fn(() => {
    return { mutate: mockMutate };
  }),
}));

jest.mock('~/hooks/useLocalize', () => {
  const fn = jest.fn(() => mockLocalize) as jest.Mock & {
    TranslationKeys: Record<string, never>;
  };
  fn.TranslationKeys = {};
  return { __esModule: true, default: fn, TranslationKeys: {} };
});

jest.mock('../useDelayedUploadToast', () => ({
  useDelayedUploadToast: jest.fn(() => ({
    startUploadTimer: jest.fn(),
    clearUploadTimer: jest.fn(),
  })),
}));

jest.mock('~/utils/heicConverter', () => ({
  processFileForUpload: mockProcessFileForUpload,
}));

jest.mock('../useClientResize', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    isConfigPending: mockIsConfigPending,
    waitForConfig: mockWaitForConfig,
    resizeImageIfNeeded: mockResizeImageIfNeeded,
  })),
}));

const mockAddFile = jest.fn();
const mockReplaceFile = jest.fn();
const mockUpdateFileById = jest.fn();
const mockDeleteFileById = jest.fn();

jest.mock('../useUpdateFiles', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    addFile: mockAddFile,
    replaceFile: mockReplaceFile,
    updateFileById: mockUpdateFileById,
    deleteFileById: mockDeleteFileById,
  })),
}));

jest.mock('~/utils', () => ({
  ...jest.requireActual('~/utils'),
  logger: { log: jest.fn() },
  validateFiles: jest.fn(() => true),
  cachePreview: jest.fn(),
  getCachedPreview: jest.fn(() => undefined),
  removePreviewEntry: jest.fn(),
}));

describe('useFileHandling: the new chat seed on uploads (LC-10a)', () => {
  const textFile = () => new File(['hello'], 'test.txt', { type: 'text/plain' });

  beforeEach(() => {
    jest.clearAllMocks();
    mockConversation = {};
    mockFileConfig = null;
    mockIsConfigPending = false;
    mockIsTemporary = false;
    mockChatIndex = 0;
    mockImageDecodes = true;
    mockWaitForConfig.mockResolvedValue(undefined);
    mockProcessFileForUpload.mockImplementation(async (file: File) => file);
    mockResizeImageIfNeeded.mockImplementation(async (file: File) => ({ file, resized: false }));
    localStorage.clear();
    clearNewChatSeed(0);
    clearNewChatSeed(1);
  });

  afterEach(() => {
    clearNewChatSeed(0);
    clearNewChatSeed(1);
  });

  const loadHooks = async () => await import('../useFileHandling');

  const upload = async (run: () => { handleFiles: (files: File[]) => Promise<unknown> }) => {
    const { result } = renderHook(run);
    await act(async () => {
      await result.current.handleFiles([textFile()]);
    });
    expect(mockMutate).toHaveBeenCalledTimes(1);
    const formData: FormData = mockMutate.mock.calls.at(-1)[0];
    mockMutate.mockClear();
    return formData;
  };

  it('a new chat upload carries the chat seed and no conversationId; every upload carries the same seed', async () => {
    mockConversation = { conversationId: Constants.NEW_CONVO as string, endpoint: 'openAI' };
    const { default: useFileHandling } = await loadHooks();

    const first = await upload(() => useFileHandling());
    const seed = first.get('clientRequestId');
    expect(typeof seed).toBe('string');
    expect(seed).toBe(peekNewChatSeed(0));
    expect(first.get('conversationId')).toBeNull();

    const second = await upload(() => useFileHandling());
    expect(second.get('clientRequestId')).toBe(seed);
  });

  it('an upload while the first turn is in flight (no conversation id yet) carries the same seed', async () => {
    mockConversation = { conversationId: Constants.NEW_CONVO as string, endpoint: 'openAI' };
    const { default: useFileHandling } = await loadHooks();
    const before = await upload(() => useFileHandling());

    mockConversation = { conversationId: null, endpoint: 'openAI' };
    const inFlight = await upload(() => useFileHandling());

    expect(inFlight.get('clientRequestId')).toBe(before.get('clientRequestId'));
    expect(inFlight.get('conversationId')).toBeNull();
  });

  it('an existing chat upload sends its conversationId and never a seed', async () => {
    mockConversation = { conversationId: 'convo-123', endpoint: 'openAI' };
    const { default: useFileHandling } = await loadHooks();

    const formData = await upload(() => useFileHandling());

    expect(formData.get('conversationId')).toBe('convo-123');
    expect(formData.get('clientRequestId')).toBeNull();
    expect(peekNewChatSeed(0)).toBeUndefined();
  });

  it('AC-22(i) an agent or assistant builder upload carries no seed and mints none', async () => {
    mockConversation = { conversationId: Constants.NEW_CONVO as string, endpoint: 'openAI' };
    const { default: useFileHandling } = await loadHooks();

    const agent = await upload(() =>
      useFileHandling({ additionalMetadata: { agent_id: 'agent-123' } }),
    );
    const assistant = await upload(() =>
      useFileHandling({ additionalMetadata: { assistant_id: 'asst-123' } }),
    );

    expect(agent.get('clientRequestId')).toBeNull();
    expect(assistant.get('clientRequestId')).toBeNull();
    expect(peekNewChatSeed(0)).toBeUndefined();

    /** With a seed held for the composer, a builder upload still sends none. */
    const held = mintNewChatSeed(0);
    const heldAgent = await upload(() =>
      useFileHandling({ additionalMetadata: { agent_id: 'agent-123' } }),
    );
    expect(heldAgent.get('clientRequestId')).toBeNull();
    expect(peekNewChatSeed(0)).toBe(held);
  });

  it('S3 a pane-1 composer upload carries pane 1 seed, not pane 0 seed', async () => {
    const { useFileHandlingNoChatContext } = await loadHooks();
    const paneZero = mintNewChatSeed(0);
    const paneOne = mintNewChatSeed(1);
    expect(paneOne).not.toBe(paneZero);

    const formData = await upload(() =>
      useFileHandlingNoChatContext(undefined, {
        files: new Map(),
        setFiles: jest.fn(),
        setFilesLoading: mockSetFilesLoading,
        conversation: {
          conversationId: Constants.NEW_CONVO as string,
          endpoint: 'openAI',
        } as never,
        index: 1,
      }),
    );

    expect(formData.get('clientRequestId')).toBe(paneOne);
    expect(peekNewChatSeed(0)).toBe(paneZero);
  });

  it('the chat-context variant takes the pane index from the chat context', async () => {
    mockChatIndex = 1;
    mockConversation = { conversationId: Constants.NEW_CONVO as string, endpoint: 'openAI' };
    const { default: useFileHandling } = await loadHooks();

    const formData = await upload(() => useFileHandling());

    expect(formData.get('clientRequestId')).toBe(peekNewChatSeed(1));
    expect(peekNewChatSeed(0)).toBeUndefined();
  });
});
