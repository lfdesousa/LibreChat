import { renderHook, act } from '@testing-library/react';
import { Constants, EModelEndpoint } from 'librechat-data-provider';
import type { TConversation, TMessage, TSubmission } from 'librechat-data-provider';
import type { ExtendedFile } from '~/common';
import { clearNewChatSeed, mintNewChatSeed, peekNewChatSeed } from '~/utils';
import useChatFunctions from '../useChatFunctions';

const mockNavigate = jest.fn();
const mockSetShowStopButton = jest.fn();
const mockSetIsSubmitting = jest.fn();
const mockGetEphemeralAgent = jest.fn(() => null);
const mockSetFilesToDelete = jest.fn();
const mockGetSender = jest.fn(() => 'Assistant');
const mockGetExpiry = jest.fn(() => 'expiry-key');
const mockGetQueryData = jest.fn(() => ({}));
const mockLoggerWarn = jest.fn();

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    getQueryData: mockGetQueryData,
    getQueryState: jest.fn(() => undefined),
  }),
}));

jest.mock('recoil', () => ({
  useRecoilValue: () => false,
  useSetRecoilState: (atom: unknown) =>
    String(atom).includes('isSubmitting') ? mockSetIsSubmitting : mockSetShowStopButton,
  useRecoilCallback: (factory: any) =>
    factory({
      snapshot: {
        getLoadable: () => ({ state: 'hasValue', contents: [] }),
      },
      set: jest.fn(),
      reset: jest.fn(),
    }),
}));

jest.mock('~/hooks/Files/useSetFilesToDelete', () => () => mockSetFilesToDelete);
jest.mock('~/hooks/Conversations/useGetSender', () => () => mockGetSender);
jest.mock('~/hooks/Input/useUserKey', () => () => ({ getExpiry: mockGetExpiry }));
jest.mock('~/hooks', () => ({
  useAuthContext: () => ({ user: null }),
}));
jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    isTemporary: 'isTemporary',
    isSubmittingFamily: () => 'isSubmitting',
    submissionStartFamily: () => 'submissionStart',
    showStopButtonByIndex: () => 'showStopButton',
    pendingManualSkillsByConvoId: () => 'pendingManualSkills',
    pendingQuotesByConvoId: () => 'pendingQuotes',
    messagesSiblingIdxFamily: () => 'messagesSiblingIdx',
  },
  useGetEphemeralAgent: () => mockGetEphemeralAgent,
}));
jest.mock('~/utils/logger', () => ({
  __esModule: true,
  default: {
    log: jest.fn(),
    dir: jest.fn(),
    debug: jest.fn(),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  },
}));
jest.mock('~/utils', () => ({
  ...jest.requireActual('~/utils'),
  logger: {
    log: jest.fn(),
    dir: jest.fn(),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  },
  createDualMessageContent: jest.fn(() => []),
  getRouteChatProjectId: jest.fn(() => null),
  requestChatFocus: jest.fn(),
}));

const conversation = (conversationId: string) =>
  ({
    conversationId,
    endpoint: EModelEndpoint.agents,
    model: 'gpt-4o',
    agent_id: 'agent-1',
  }) as TConversation;

function renderAsk(
  messages: TMessage[] | undefined,
  conversationId = 'conversation-1',
  options: { endpoint?: TConversation['endpoint']; isSubmitting?: boolean } = {},
) {
  const setMessages = jest.fn();
  const setSubmission = jest.fn();
  const getMessages = jest.fn(() => messages);
  const immutableConversation = conversation(conversationId);
  if ('endpoint' in options) {
    immutableConversation.endpoint = options.endpoint ?? null;
  }
  const hook = renderHook(() =>
    useChatFunctions({
      isSubmitting: options.isSubmitting ?? false,
      latestMessage: messages?.at(-1) ?? null,
      conversation: immutableConversation,
      getMessages,
      setMessages,
      setSubmission,
    }),
  );

  return { ...hook, getMessages, setMessages, setSubmission };
}

const NEW = Constants.NEW_CONVO as string;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const fileMap = (...ids: string[]) =>
  new Map(ids.map((id) => [id, { file_id: id } as ExtendedFile]));

function renderNewChat(files: Map<string, ExtendedFile> = new Map()) {
  const setSubmission = jest.fn();
  const conversation = {
    conversationId: NEW,
    endpoint: EModelEndpoint.agents,
    model: 'gpt-4o',
    agent_id: 'agent-1',
  } as TConversation;
  const hook = renderHook(() =>
    useChatFunctions({
      isSubmitting: false,
      latestMessage: null,
      conversation,
      getMessages: jest.fn(() => []),
      setMessages: jest.fn(),
      setSubmission,
      files,
      setFiles: jest.fn(),
    }),
  );
  const submit = (text: string, options: Parameters<typeof hook.result.current.ask>[1] = {}) => {
    act(() => {
      hook.result.current.ask({ text, conversationId: NEW }, options);
    });
    return (setSubmission.mock.calls.at(-1)?.[0] as TSubmission).clientRequestId;
  };
  return { ...hook, setSubmission, submit };
}

describe('useChatFunctions ask: the new chat seed (LC-10a)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetQueryData.mockReturnValue({});
    localStorage.clear();
    clearNewChatSeed(0);
  });

  afterEach(() => {
    clearNewChatSeed(0);
  });

  it('AC-22(a) the first submit takes the seed its uploads carry, and an upload in flight after ask() still carries it', () => {
    const uploadSeed = mintNewChatSeed(0);
    const { submit } = renderNewChat(fileMap('f1'));

    expect(submit('hello')).toBe(uploadSeed);
    /** After ask() the composer id is null and the server id has not arrived: an attach now. */
    expect(mintNewChatSeed(0)).toBe(uploadSeed);
    expect(peekNewChatSeed(0)).toBe(uploadSeed);
  });

  it('AC-22(b) a resend after a failed first submit carries the same seed', () => {
    const uploadSeed = mintNewChatSeed(0);
    const { submit } = renderNewChat(fileMap('f1'));

    expect(submit('hello')).toBe(uploadSeed);
    /** The failure left the composer on NEW_CONVO with its chips: the identical resend. */
    expect(submit('hello')).toBe(uploadSeed);
    expect(peekNewChatSeed(0)).toBe(uploadSeed);
  });

  it('AC-22(h) an edited resend takes a fresh seed, logging lengths only', () => {
    const uploadSeed = mintNewChatSeed(0);
    const { submit } = renderNewChat(fileMap('f1'));

    expect(submit('hello')).toBe(uploadSeed);
    const edited = submit('hello, secret plan');
    expect(edited).not.toBe(uploadSeed);
    expect(edited).toMatch(UUID_V4);
    expect(peekNewChatSeed(0)).toBe(edited);
    expect(mockLoggerWarn).toHaveBeenCalledWith('[newChatSeed] edited resend takes a fresh seed', {
      textLength: 'hello, secret plan'.length,
      fileCount: 1,
    });
    expect(JSON.stringify(mockLoggerWarn.mock.calls)).not.toContain('secret plan');
  });

  it('AC-22(h1) the same text with a CHANGED composer file set takes a fresh seed', () => {
    const uploadSeed = mintNewChatSeed(0);
    const composerFiles = fileMap('f1');
    const { submit } = renderNewChat(composerFiles);

    expect(submit('hello')).toBe(uploadSeed);
    /** The failed first submit left the chips; the user attaches one more and resends. */
    composerFiles.set('f2', { file_id: 'f2' } as ExtendedFile);
    const resent = submit('hello');

    expect(resent).not.toBe(uploadSeed);
    expect(resent).toMatch(UUID_V4);
    expect(peekNewChatSeed(0)).toBe(resent);
  });

  it('AC-22(h1) swapping one composer file for another (same count, same text) takes a fresh seed', () => {
    const uploadSeed = mintNewChatSeed(0);
    const composerFiles = fileMap('f1');
    const { submit } = renderNewChat(composerFiles);

    expect(submit('hello')).toBe(uploadSeed);
    composerFiles.clear();
    composerFiles.set('f2', { file_id: 'f2' } as ExtendedFile);
    const resent = submit('hello');

    expect(resent).not.toBe(uploadSeed);
    expect(resent).toMatch(UUID_V4);
    expect(peekNewChatSeed(0)).toBe(resent);
  });

  it('AC-22(h1) swapping one overrideFiles entry for another (same count) takes a fresh seed', () => {
    const uploadSeed = mintNewChatSeed(0);
    const { submit } = renderNewChat(fileMap('c1'));
    const withOverride = (...ids: string[]) => ({
      overrideFiles: ids.map((file_id) => ({ file_id })) as never,
    });

    expect(submit('hello', withOverride('g1'))).toBe(uploadSeed);
    const resent = submit('hello', withOverride('g2'));

    expect(resent).not.toBe(uploadSeed);
    expect(resent).toMatch(UUID_V4);
    expect(peekNewChatSeed(0)).toBe(resent);
  });

  it('AC-22(h1) removing the first of two composer files (same text) takes a fresh seed', () => {
    const uploadSeed = mintNewChatSeed(0);
    const composerFiles = fileMap('f1', 'f2');
    const { submit } = renderNewChat(composerFiles);

    expect(submit('hello')).toBe(uploadSeed);
    composerFiles.delete('f1');
    const resent = submit('hello');

    expect(resent).not.toBe(uploadSeed);
    expect(resent).toMatch(UUID_V4);
    expect(peekNewChatSeed(0)).toBe(resent);
  });

  it('AC-22(h) the digest follows overrideFiles when given, not the composer map', () => {
    const uploadSeed = mintNewChatSeed(0);
    const composerFiles = fileMap('c1');
    const { submit } = renderNewChat(composerFiles);
    const withOverride = (...ids: string[]) => ({
      overrideFiles: ids.map((file_id) => ({ file_id })) as never,
    });

    expect(submit('hello', withOverride('g1'))).toBe(uploadSeed);
    /** The composer map changes but the submission's files do not: an identical resend. */
    composerFiles.clear();
    composerFiles.set('c2', { file_id: 'c2' } as ExtendedFile);
    expect(submit('hello', withOverride('g1'))).toBe(uploadSeed);
    /** The composer map is the same as before but overrideFiles changed: an edited resend. */
    expect(submit('hello', withOverride('g1', 'g2'))).not.toBe(uploadSeed);
  });

  it('AC-22(d) an explicit override (queued, steered, recovered) wins and leaves the seed alone', () => {
    const uploadSeed = mintNewChatSeed(0);
    const { submit } = renderNewChat(fileMap('f1'));

    expect(submit('hello', { overrideClientRequestId: 'queued-1' })).toBe('queued-1');
    expect(peekNewChatSeed(0)).toBe(uploadSeed);
    /** An ordinary submit (no override: ChatForm passes `context?.clientRequestId`) takes the seed. */
    expect(submit('hello', { overrideClientRequestId: undefined })).toBe(uploadSeed);
  });

  it('N1 with no seed held ask() returns a fresh v4 and stores nothing', () => {
    const { submit } = renderNewChat();

    const first = submit('hello');
    expect(first).toMatch(UUID_V4);
    expect(peekNewChatSeed(0)).toBeUndefined();
    expect(localStorage.length).toBe(0);
    expect(submit('hello')).not.toBe(first);
  });

  it('an existing conversation never touches the seed', () => {
    const uploadSeed = mintNewChatSeed(0);
    const { result, setSubmission } = renderAsk([], 'conversation-1');

    act(() => {
      result.current.ask({ text: 'hello', conversationId: 'conversation-1' });
    });

    const sent = (setSubmission.mock.calls.at(-1)?.[0] as TSubmission).clientRequestId;
    expect(sent).toMatch(UUID_V4);
    expect(sent).not.toBe(uploadSeed);
    expect(peekNewChatSeed(0)).toBe(uploadSeed);
  });
});
