import type { MemoriesResponse, TUserMemory, MemoryArtifact } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks/useLocalize';

type HandleMemoryArtifactParams = {
  memoryArtifact: MemoryArtifact;
  currentData: MemoriesResponse;
};

type MemoryKeyErrorParams = {
  key: string;
  memories?: TUserMemory[];
  agentId?: string;
  originalKey?: string;
};

type MemoryApiError = {
  response?: { data?: { error?: string } };
};

/** Mirrors the `key` validator on the memory schema in `packages/data-schemas`. */
export const MEMORY_KEY_PATTERN = /^[a-z_]+$/;

/** Sentinel for "no layer filter applied" in the panel's layer dropdown. Never a
 *  real `TUserMemory.layer` value, so it can share the same option-value space. */
export const MEMORY_LAYER_ALL = 'all' as const;

/** The sovereign-memory layers the panel filter offers, in display order. Mirrors
 *  the AuditTrace 4-layer model plus `corpus` (ADR-026/ADR-062) — the adapter is
 *  the only source of truth for which of these a given entry actually is. */
export const MEMORY_LAYER_FILTER_VALUES = [
  'episodic',
  'semantic',
  'procedural',
  'conversational',
  'corpus',
] as const;

export type MemoryLayerFilterValue = (typeof MEMORY_LAYER_FILTER_VALUES)[number];

/** Localization key for each layer's badge/filter-option label. A `Record` keyed
 *  by the fixed layer set, so a typo here is a TS error against `TranslationKeys`
 *  rather than a silently-blank badge. */
const MEMORY_LAYER_LABEL_KEYS = {
  episodic: 'com_ui_memory_layer_episodic',
  semantic: 'com_ui_memory_layer_semantic',
  procedural: 'com_ui_memory_layer_procedural',
  conversational: 'com_ui_memory_layer_conversational',
  corpus: 'com_ui_memory_layer_corpus',
} as const satisfies Record<MemoryLayerFilterValue, TranslationKeys>;

/**
 * @returns the localization key for `layer`'s badge/filter-option label, or
 * `null` for a layer value the panel does not recognize (renders no badge
 * rather than a raw, unlocalized string).
 */
export function getMemoryLayerLabelKey(layer: string): TranslationKeys | null {
  return layer in MEMORY_LAYER_LABEL_KEYS
    ? MEMORY_LAYER_LABEL_KEYS[layer as MemoryLayerFilterValue]
    : null;
}

/**
 * @returns true when at least one entry carries a `layer` — the panel's signal
 * that the sovereign-memory adapter (M3-WU-D2-2) is active, since the default
 * `mongo` backend never projects `layer`/`readOnly` on any entry. Used to gate
 * the layer filter and the create-target hint so the default backend's panel
 * renders byte-equivalent to upstream (no filter chrome forced).
 */
export function hasSovereignLayerData(memories: TUserMemory[] | undefined): boolean {
  return (memories ?? []).some((memory) => memory.layer != null);
}

/** Usage totals track the shared personal pool only; agent-partition
 *  writes never affect the personal usage badge. */
const isPersonal = (agentId?: string) => agentId == null;

const samePartition = (memory: TUserMemory, agentId?: string) =>
  (memory.agentId ?? undefined) === (agentId ?? undefined);

/**
 * Validates a memory key the same way the server does, plus a partition-aware
 * duplicate check so the conflict surfaces before the request is sent.
 * @returns the localization key of the failure, or null when the key is valid
 */
export function getMemoryKeyError({
  key,
  memories,
  agentId,
  originalKey,
}: MemoryKeyErrorParams): TranslationKeys | null {
  const trimmed = key.trim();

  if (!trimmed) {
    return 'com_ui_field_required';
  }

  if (!MEMORY_KEY_PATTERN.test(trimmed)) {
    return 'com_ui_memory_key_validation';
  }

  if (trimmed === originalKey) {
    return null;
  }

  const isTaken = memories?.some(
    (memory) => memory.key === trimmed && samePartition(memory, agentId),
  );

  return isTaken === true ? 'com_ui_memory_key_exists' : null;
}

/**
 * @returns the localization key of the failure, or null when the value is valid
 */
export function getMemoryValueError(value: string): TranslationKeys | null {
  return value.trim() ? null : 'com_ui_field_required';
}

export function getMemoryApiErrorMessage(error: Error, fallback: string): string {
  if (!('response' in error)) {
    return fallback;
  }

  const message = (error as Error & MemoryApiError).response?.data?.error;
  return typeof message === 'string' && message.trim() ? message : fallback;
}

/**
 * Pure function to handle memory artifact updates
 * @param params - Object containing memoryArtifact and currentData
 * @returns Updated MemoriesResponse or undefined if no update needed
 */
export function handleMemoryArtifact({
  memoryArtifact,
  currentData,
}: HandleMemoryArtifactParams): MemoriesResponse | undefined {
  const { type, key, value, tokenCount = 0, agentId } = memoryArtifact;

  if (type === 'update' && !value) {
    return undefined;
  }

  const memories = currentData.memories;
  const existingIndex = memories.findIndex((m) => m.key === key && samePartition(m, agentId));

  if (type === 'delete') {
    if (existingIndex === -1) {
      return undefined;
    }

    const deletedMemory = memories[existingIndex];
    const newMemories = [...memories];
    newMemories.splice(existingIndex, 1);

    const totalTokens = isPersonal(agentId)
      ? currentData.totalTokens - (deletedMemory.tokenCount || 0)
      : currentData.totalTokens;
    const usagePercentage = currentData.tokenLimit
      ? Math.min(100, Math.round((totalTokens / currentData.tokenLimit) * 100))
      : null;

    return {
      ...currentData,
      memories: newMemories,
      totalTokens,
      usagePercentage,
    };
  }

  if (type === 'update') {
    const timestamp = new Date().toISOString();
    let totalTokens = currentData.totalTokens;
    let newMemories: TUserMemory[];
    const updatedMemory: TUserMemory = {
      key,
      value: value!,
      tokenCount,
      updated_at: timestamp,
      ...(agentId != null ? { agentId } : {}),
    };

    if (existingIndex >= 0) {
      const oldTokenCount = memories[existingIndex].tokenCount || 0;
      if (isPersonal(agentId)) {
        totalTokens = totalTokens - oldTokenCount + tokenCount;
      }

      newMemories = [...memories];
      newMemories[existingIndex] = {
        ...updatedMemory,
        agentName: memories[existingIndex].agentName,
      };
    } else {
      if (isPersonal(agentId)) {
        totalTokens = totalTokens + tokenCount;
      }
      newMemories = [...memories, updatedMemory];
    }

    const usagePercentage = currentData.tokenLimit
      ? Math.min(100, Math.round((totalTokens / currentData.tokenLimit) * 100))
      : null;

    return {
      ...currentData,
      memories: newMemories,
      totalTokens,
      usagePercentage,
    };
  }

  return undefined;
}
