import { Constants, LocalStorageKeys } from 'librechat-data-provider';
import {
  clearNewChatSeed,
  fnv1a64,
  isServerConversationId,
  mintNewChatSeed,
  observeNewChatSubmission,
  peekNewChatSeed,
  resolveNewChatSeed,
  setNewChatSeedDigest,
  submissionDigest,
} from './newChatSeed';
import {
  claimComposerDraftTab,
  getBrowserTabId,
  getFilesDraft,
  getNewConversationDraftId,
  releaseComposerDraftTab,
  setFilesDraft,
} from './drafts';

const NEW_CONVO = Constants.NEW_CONVO as string;
const NEW_ID = getNewConversationDraftId(0);
const NEW_KEY = `${LocalStorageKeys.FILES_DRAFT}${NEW_ID}`;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Another browser tab that is alive: its presence key is what `isTabLive` reads. */
const markTabLive = (tabId: string) =>
  localStorage.setItem(`librechat-live-tab:${tabId}`, JSON.stringify({ seenAt: Date.now() }));

/** A NEW-chat record written by another (live) tab, byte for byte. */
const writeForeignRecord = (tabId: string, seed: string, digest?: string): string => {
  markTabLive(tabId);
  const raw = JSON.stringify({
    fileIds: ['fa'],
    tabId,
    clientRequestId: seed,
    ...(digest ? { clientRequestDigest: digest } : {}),
  });
  localStorage.setItem(NEW_KEY, raw);
  return raw;
};

describe('newChatSeed', () => {
  beforeEach(() => {
    localStorage.clear();
    clearNewChatSeed(0);
    clearNewChatSeed(1);
  });

  afterEach(() => {
    clearNewChatSeed(0);
    clearNewChatSeed(1);
    localStorage.clear();
  });

  describe('AC-22(e) carry', () => {
    it('keeps the seed and digest through the writers that rebuild the record from scratch', () => {
      const seed = mintNewChatSeed(0, true);
      setNewChatSeedDigest(0, 'fnv1a64:0000000000000001', true);
      const afterAttach = localStorage.getItem(NEW_KEY);
      expect(JSON.parse(afterAttach as string)).toMatchObject({
        clientRequestId: seed,
        clientRequestDigest: 'fnv1a64:0000000000000001',
      });

      /** The `useAutoSave.ts:453` write: names files, names no seed. */
      setFilesDraft(NEW_ID, { fileIds: ['f1'], pastedTextIds: [], pendingPastes: {} });
      /** The `:168` restore write and the `:359` switch write have the same shape. */
      setFilesDraft(NEW_ID, { fileIds: ['f1'], pastedTextIds: ['f1'], pendingPastes: {} });

      const stored = getFilesDraft(NEW_ID);
      expect(stored.clientRequestId).toBe(seed);
      expect(stored.clientRequestDigest).toBe('fnv1a64:0000000000000001');
      expect(stored.fileIds).toEqual(['f1']);

      /** Removing the last chip must not delete a record that still holds a seed. */
      setFilesDraft(NEW_ID, { fileIds: [], pastedTextIds: [], pendingPastes: {} });
      expect(getFilesDraft(NEW_ID).clientRequestId).toBe(seed);
      expect(getFilesDraft(NEW_ID).clientRequestDigest).toBe('fnv1a64:0000000000000001');
    });
  });

  describe('AC-22(c) restore', () => {
    const freshModules = async () => {
      jest.resetModules();
      return await import('./newChatSeed');
    };

    it('a record this tab owns (or whose owner is gone) restores the seed on an empty slot', async () => {
      localStorage.setItem(
        NEW_KEY,
        JSON.stringify({
          fileIds: ['fa'],
          tabId: 'tab-that-closed',
          clientRequestId: 'seed-restored',
        }),
      );
      const seed = await freshModules();
      expect(seed.peekNewChatSeed(0)).toBe('seed-restored');
    });

    it('a record owned by a LIVE other tab does not restore into this tab', async () => {
      writeForeignRecord('tab-live-A', 'seed-of-A');
      const seed = await freshModules();
      expect(seed.peekNewChatSeed(0)).toBeUndefined();
    });
  });

  describe('AC-22(g) non-owner', () => {
    it("never overwrites, clears or rewrites the live owner's seed and digest", () => {
      const raw = writeForeignRecord('tab-live-A', 'seed-A', 'fnv1a64:00000000000000aa');
      expect(getBrowserTabId()).not.toBe('tab-live-A');

      /** B attaches: its seed lives in memory, A's record is byte-equal. */
      const seedB = mintNewChatSeed(0, true);
      expect(seedB).toMatch(UUID_V4);
      expect(seedB).not.toBe('seed-A');
      expect(localStorage.getItem(NEW_KEY)).toBe(raw);

      /** B submits: its digest lands in B's slot only. */
      expect(resolveNewChatSeed(0, 'fnv1a64:00000000000000bb', true)).toBe(seedB);
      expect(localStorage.getItem(NEW_KEY)).toBe(raw);
      expect(resolveNewChatSeed(0, 'fnv1a64:00000000000000bb', true)).toBe(seedB);

      /** B's first send succeeds (C1) and B's composer discards (C2): the slot goes, A's record stays. */
      clearNewChatSeed(0);
      expect(peekNewChatSeed(0)).toBeUndefined();
      expect(localStorage.getItem(NEW_KEY)).toBe(raw);
      mintNewChatSeed(0, true);
      clearNewChatSeed(0);
      expect(localStorage.getItem(NEW_KEY)).toBe(raw);
    });

    it("the owner's own ask() takes the owner's seed, and its clear does drop the record's seed", () => {
      setFilesDraft(NEW_ID, { fileIds: ['f1'], pendingPastes: {} });
      expect(getFilesDraft(NEW_ID).tabId).toBe(getBrowserTabId());
      const seedA = mintNewChatSeed(0, true);
      expect(getFilesDraft(NEW_ID).clientRequestId).toBe(seedA);
      expect(resolveNewChatSeed(0, 'fnv1a64:00000000000000aa', true)).toBe(seedA);

      clearNewChatSeed(0);
      const after = getFilesDraft(NEW_ID);
      expect(after.clientRequestId).toBeUndefined();
      expect(after.clientRequestDigest).toBeUndefined();
      expect(after.fileIds).toEqual(['f1']);
      expect(peekNewChatSeed(0)).toBeUndefined();
    });
  });

  describe('AC-22(h) digest rule', () => {
    const first = submissionDigest('hello', [{ file_id: 'f1' }]);

    it('(h1) an EDITED resend takes a fresh seed and the slot now holds the new pair', () => {
      const seed = mintNewChatSeed(0, true);
      expect(resolveNewChatSeed(0, first, true)).toBe(seed);

      const edited = submissionDigest('hello again', [{ file_id: 'f1' }]);
      const resent = resolveNewChatSeed(0, edited, true);
      expect(resent).not.toBe(seed);
      expect(resent).toMatch(UUID_V4);
      expect(peekNewChatSeed(0)).toBe(resent);
      expect(getFilesDraft(NEW_ID).clientRequestId).toBe(resent);
      expect(getFilesDraft(NEW_ID).clientRequestDigest).toBe(edited);
      /** The pair is replaced as a unit: the same edited text now resends under the new seed. */
      expect(resolveNewChatSeed(0, edited, true)).toBe(resent);

      /** A changed file set is an edit too. */
      const withMoreFiles = submissionDigest('hello again', [{ file_id: 'f1' }, { file_id: 'f2' }]);
      expect(resolveNewChatSeed(0, withMoreFiles, true)).not.toBe(resent);
    });

    it('(h2) an IDENTICAL resend keeps the same seed', () => {
      const seed = mintNewChatSeed(0, true);
      expect(resolveNewChatSeed(0, first, true)).toBe(seed);
      expect(resolveNewChatSeed(0, first, true)).toBe(seed);
      expect(resolveNewChatSeed(0, submissionDigest('hello', [{ file_id: 'f1' }]), true)).toBe(
        seed,
      );
    });

    it('(h) pins the digest through the canonicaliser and the algorithm tag', () => {
      expect(submissionDigest('hi', [{ file_id: 'f1' }])).toBe('fnv1a64:0e8499f4da830663');
      expect(submissionDigest('hi!', [{ file_id: 'f1' }])).toBe('fnv1a64:af5516bdeca55998');
      /** The file set is sorted: attach order does not change the digest. */
      expect(submissionDigest('x', [{ file_id: 'b' }, { file_id: 'a' }])).toBe(
        submissionDigest('x', [{ file_id: 'a' }, { file_id: 'b' }]),
      );
      /** The bare hash, against the published FNV-1a 64 reference vectors. */
      expect(fnv1a64('')).toBe('cbf29ce484222325');
      expect(fnv1a64('a')).toBe('af63dc4c8601ec8c');
      expect(fnv1a64('["hi",["f1"]]')).toBe('0e8499f4da830663');
    });
  });

  describe('N1 no seed held', () => {
    it('returns a fresh v4 and stores nothing', () => {
      const id = resolveNewChatSeed(0, 'fnv1a64:0000000000000001', true);
      expect(id).toMatch(UUID_V4);
      expect(peekNewChatSeed(0)).toBeUndefined();
      expect(localStorage.getItem(NEW_KEY)).toBeNull();
      expect(resolveNewChatSeed(0, 'fnv1a64:0000000000000001', true)).not.toBe(id);
    });
  });

  describe('S2 the two other record writers carry the seed', () => {
    it('claimComposerDraftTab carries the seed and digest of a chip-less record this tab may read', () => {
      localStorage.setItem(
        NEW_KEY,
        JSON.stringify({
          fileIds: [],
          clientRequestId: 'seed-1',
          clientRequestDigest: 'fnv1a64:0000000000000001',
        }),
      );
      expect(claimComposerDraftTab(NEW_ID)).toBe(true);
      const claimed = getFilesDraft(NEW_ID);
      expect(claimed.tabId).toBe(getBrowserTabId());
      expect(claimed.clientRequestId).toBe('seed-1');
      expect(claimed.clientRequestDigest).toBe('fnv1a64:0000000000000001');
    });

    it("claimComposerDraftTab does not adopt a live other tab's seed", () => {
      markTabLive('tab-live-A');
      localStorage.setItem(
        NEW_KEY,
        JSON.stringify({ fileIds: [], tabId: 'tab-live-A', clientRequestId: 'seed-A' }),
      );
      expect(claimComposerDraftTab(NEW_ID)).toBe(true);
      expect(getFilesDraft(NEW_ID).clientRequestId).toBeUndefined();
    });

    it('releaseComposerDraftTab keeps a chip-less record that still holds a seed', () => {
      setFilesDraft(NEW_ID, { fileIds: ['f1'], pendingPastes: {} });
      mintNewChatSeed(0, true);
      setNewChatSeedDigest(0, 'fnv1a64:0000000000000001', true);
      setFilesDraft(NEW_ID, { fileIds: [], pastedTextIds: [], pendingPastes: {} });

      releaseComposerDraftTab(NEW_ID);
      const kept = getFilesDraft(NEW_ID);
      expect(kept.clientRequestId).toBe(peekNewChatSeed(0));
      expect(kept.clientRequestDigest).toBe('fnv1a64:0000000000000001');
    });

    it('releaseComposerDraftTab still removes a chip-less record that holds no seed', () => {
      setFilesDraft(NEW_ID, { fileIds: ['f1'], pendingPastes: {} });
      setFilesDraft(NEW_ID, { fileIds: [], pastedTextIds: [], pendingPastes: {} });
      expect(localStorage.getItem(NEW_KEY)).toBeNull();
      /** A claim-only record is released as before. */
      localStorage.setItem(NEW_KEY, JSON.stringify({ fileIds: [], tabId: getBrowserTabId() }));
      releaseComposerDraftTab(NEW_ID);
      expect(localStorage.getItem(NEW_KEY)).toBeNull();
    });
  });

  describe('AC-22(f) the first send ends the seed (C1 observer)', () => {
    it('clears on adopting a server id after a submit from a new chat, even across a remount', () => {
      const first = mintNewChatSeed(0, true);
      expect(observeNewChatSubmission(0, NEW_CONVO, false)).toBe(false);
      expect(observeNewChatSubmission(0, NEW_CONVO, true)).toBe(false);
      expect(observeNewChatSubmission(0, null, true)).toBe(false);
      expect(peekNewChatSeed(0)).toBe(first);

      /** The hook host remounted here: the observer holds no state of its own. */
      expect(observeNewChatSubmission(0, 'server-convo-1', true)).toBe(true);
      expect(peekNewChatSeed(0)).toBeUndefined();
      expect(getFilesDraft(NEW_ID).clientRequestId).toBeUndefined();
      expect(observeNewChatSubmission(0, 'server-convo-1', false)).toBe(false);
    });

    it('keeps the seed for the resend when the attempt returns to a new chat, and ignores placeholders', () => {
      const first = mintNewChatSeed(0, true);
      observeNewChatSubmission(0, NEW_CONVO, true);
      expect(observeNewChatSubmission(0, '_failed-first-submit', false)).toBe(false);
      expect(observeNewChatSubmission(0, NEW_CONVO, false)).toBe(false);
      expect(peekNewChatSeed(0)).toBe(first);

      /** A later server id with no submit in flight from this composer clears nothing. */
      expect(observeNewChatSubmission(0, 'server-convo-2', false)).toBe(false);
      expect(peekNewChatSeed(0)).toBe(first);
    });

    it('recognises only server-issued conversation ids', () => {
      expect(isServerConversationId('0f8fad5b-d9cb-469f-a165-70867728950e')).toBe(true);
      for (const notServer of [
        undefined,
        null,
        '',
        NEW_CONVO,
        'new:1',
        Constants.PENDING_CONVO as string,
        `${Constants.PENDING_CONVO}:1`,
        '_placeholder',
      ]) {
        expect(isServerConversationId(notServer)).toBe(false);
      }
    });
  });
});
