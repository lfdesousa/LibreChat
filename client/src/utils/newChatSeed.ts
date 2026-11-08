import { v4 } from 'uuid';
import { Constants } from 'librechat-data-provider';
import {
  getFilesDraft,
  setFilesDraft,
  isPendingDraftId,
  getNewConversationDraftId,
  isNewConversationDraftId,
  isFilesDraftOwnedByThisTab,
} from './drafts';
import logger from './logger';

/**
 * LC-10a, A': the seed of a NEW chat (the `clientRequestId` of its first submission) is minted at
 * the first attach, so an upload made before the chat exists can carry it. The server derives the
 * chat's conversation id from `(userId, seed)` (`deriveNewConversationId`), and the upload derives
 * the same id as the memory server's `X-Session-Id`: the chat's files and the chat meet on one id.
 *
 * The seed and the digest of the submission it was first used for live in two places:
 *  - the module slot below (per composer index): the in-tab truth, always written;
 *  - the NEW-chat draft record (`getNewConversationDraftId(index)`): so a reload, or a tab that
 *    inherits a dead tab's record, finds it. Written only when this tab OWNS the record and
 *    `persist` (drafts saving) is on; a tab that does not own it never overwrites the owner's.
 *
 * The seed and digest are client-local correctness devices, never an authorization input: the
 * server's trust boundary is `user_id`.
 *
 * The slot is module state by design (it mirrors `newConversationDraftTokens` in `drafts.ts`):
 * it must outlive any one component, because the first turn's hook host can re-render while the
 * upload and the submission are in flight. It is bounded by composer panes, cleared by
 * `clearNewChatSeed` at every lifecycle end, and holds no resource that needs closing.
 */
type SeedSlot = { seed: string; digest?: string };

const slots = new Map<number, SeedSlot>();

/** Panes whose current composer submitted a first turn from a new chat and are waiting for the
 * server's conversation id. Module state, not a hook ref: the hook host is not proven to survive
 * the `/c/new` to `/c/<id>` navigation (`ChatRoute` returns null while its conversation is
 * missing), and a remount must not lose the fact that this seed is spent. */
const submittedFromNew = new Set<number>();

/** FNV-1a 64-bit offset basis and prime. */
const FNV_OFFSET_BASIS = BigInt('0xcbf29ce484222325');
const FNV_PRIME = BigInt('0x100000001b3');
const MASK_64 = BigInt('0xffffffffffffffff');

const DIGEST_TAG = 'fnv1a64:';

/** FNV-1a 64-bit over the UTF-8 bytes of `input`, as 16 lowercase hex digits. Synchronous on
 * purpose: `ask()` is synchronous and SubtleCrypto is asynchronous. An equality device for the
 * user's own composer, not a security primitive. */
export const fnv1a64 = (input: string): string => {
  let hash = FNV_OFFSET_BASIS;
  for (const byte of new TextEncoder().encode(input)) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, '0');
};

/** Digest of what a submission carries: the trimmed text and the sorted attached `file_id`s,
 * stored as `fnv1a64:<hex>`. The tag makes a future algorithm change compare unequal (a fresh
 * seed), never a wrong dedup. */
export const submissionDigest = (
  text: string,
  files: ReadonlyArray<{ file_id: string }>,
): string => {
  const fileIds = files.map((file) => file.file_id).sort();
  return `${DIGEST_TAG}${fnv1a64(JSON.stringify([text, fileIds]))}`;
};

/** The held pair: the memory slot, else the NEW-chat record when this tab may read it. */
const held = (index: number): SeedSlot | undefined => {
  const slot = slots.get(index);
  if (slot != null) {
    return slot;
  }
  const record = getFilesDraft(getNewConversationDraftId(index));
  if (record.clientRequestId == null || !isFilesDraftOwnedByThisTab(record)) {
    return undefined;
  }
  return { seed: record.clientRequestId, digest: record.clientRequestDigest };
};

/** Writes the pair into the NEW-chat record when this tab owns it and drafts are saved. */
const persistPair = (index: number, pair: SeedSlot, persist: boolean): void => {
  if (!persist) {
    return;
  }
  const id = getNewConversationDraftId(index);
  const record = getFilesDraft(id);
  if (!isFilesDraftOwnedByThisTab(record)) {
    return;
  }
  setFilesDraft(id, {
    ...record,
    clientRequestId: pair.seed,
    clientRequestDigest: pair.digest,
  });
};

/** The seed held for composer `index`, without creating one. */
export const peekNewChatSeed = (index = 0): string | undefined => held(index)?.seed;

/** The seed for composer `index`'s new chat, minted once (`v4()`) and then reused. */
export const mintNewChatSeed = (index = 0, persist = false): string => {
  const existing = held(index);
  if (existing != null) {
    slots.set(index, existing);
    return existing.seed;
  }
  const pair: SeedSlot = { seed: v4() };
  slots.set(index, pair);
  persistPair(index, pair, persist);
  return pair.seed;
};

/** Records the digest of the submission the held seed is first used for. */
export const setNewChatSeedDigest = (index: number, digest: string, persist = false): void => {
  const existing = held(index);
  if (existing == null) {
    return;
  }
  const pair: SeedSlot = { seed: existing.seed, digest };
  slots.set(index, pair);
  persistPair(index, pair, persist);
};

/**
 * The `clientRequestId` for a new chat's first `ask()`:
 *  - no seed held (a chat that never attached): `v4()`, nothing stored (upstream behaviour);
 *  - held, no digest yet (the first submit): the held seed, and this submission's digest is stored;
 *  - held, same digest (an identical resend): the held seed;
 *  - held, other digest (an edited resend): a fresh seed with the new digest, replacing the pair.
 *    Reusing the seed would deduplicate the edited text into the original generation.
 */
export const resolveNewChatSeed = (
  index: number,
  digest: string,
  persist = false,
  shape: { textLength: number; fileCount: number } = { textLength: 0, fileCount: 0 },
): string => {
  const existing = held(index);
  if (existing == null) {
    return v4();
  }
  if (existing.digest == null) {
    setNewChatSeedDigest(index, digest, persist);
    return existing.seed;
  }
  if (existing.digest === digest) {
    return existing.seed;
  }
  const fresh: SeedSlot = { seed: v4(), digest };
  slots.set(index, fresh);
  persistPair(index, fresh, persist);
  /** Lengths only, never content. */
  logger.warn('[newChatSeed] edited resend takes a fresh seed', {
    textLength: shape.textLength,
    fileCount: shape.fileCount,
  });
  return fresh.seed;
};

/** Whether `id` is a conversation id issued by the server: not empty, not the NEW_CONVO or
 * PENDING sentinels or their per-pane variants, not the `_` placeholder a failed first submit
 * installs, and not a draft key. */
export const isServerConversationId = (id?: string | null): id is string =>
  typeof id === 'string' &&
  id.length > 0 &&
  id !== Constants.NEW_CONVO &&
  !id.startsWith('_') &&
  !isPendingDraftId(id) &&
  !isNewConversationDraftId(id);

/**
 * (C1) Observes composer `index`'s conversation id and run state; returns true when the first
 * send has SUCCEEDED and the seed was cleared. Defined as: a submit started from `NEW_CONVO` or
 * the in-flight `null`, and the composer then adopted a server id. A return to `NEW_CONVO` (the
 * failed-submit cancel) ends the attempt and KEEPS the seed for the resend. A `_` placeholder
 * changes nothing. Called from an effect with no `saveDrafts` gate: a drafts-off user's slot
 * must clear too.
 */
export const observeNewChatSubmission = (
  index: number,
  conversationId: string | null | undefined,
  isSubmitting: boolean,
): boolean => {
  const onNewChat = conversationId == null || conversationId === Constants.NEW_CONVO;
  if (isSubmitting && onNewChat) {
    submittedFromNew.add(index);
    return false;
  }
  if (conversationId === Constants.NEW_CONVO) {
    submittedFromNew.delete(index);
    return false;
  }
  if (submittedFromNew.has(index) && isServerConversationId(conversationId)) {
    clearNewChatSeed(index);
    return true;
  }
  return false;
};

/**
 * Ends the seed's life for composer `index`. The memory slot is ALWAYS cleared. The record half
 * is cleared only when this tab owns the NEW-chat record: another tab's clear must not rewrite
 * the owner's record (the owner would lose the seed on reload).
 */
export const clearNewChatSeed = (index = 0): void => {
  slots.delete(index);
  submittedFromNew.delete(index);
  const id = getNewConversationDraftId(index);
  const record = getFilesDraft(id);
  if (record.clientRequestId == null && record.clientRequestDigest == null) {
    return;
  }
  if (!isFilesDraftOwnedByThisTab(record)) {
    return;
  }
  setFilesDraft(id, record, { dropSeed: true });
};
