import React, { useState, useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import {
  OGDialog,
  OGDialogTemplate,
  Button,
  FieldMessage,
  Label,
  Input,
  Spinner,
  Textarea,
  useToastContext,
} from '@librechat/client';
import type { TUserMemory } from 'librechat-data-provider';
import { getMemoryKeyError, getMemoryValueError, getMemoryApiErrorMessage } from '~/utils/memory';
import { useUpdateMemoryMutation, useMemoriesQuery } from '~/data-provider';
import { getMemoryAddress, getMemoryUpdateAddress } from './address';
import { useLocalize, useHasAccess, useClockFormat } from '~/hooks';
import MemoryUsageBadge from './MemoryUsageBadge';

interface MemoryEditDialogProps {
  memory: TUserMemory | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  triggerRef?: React.MutableRefObject<HTMLButtonElement | null>;
}

const formatDateTime = (dateString: string, hour12?: boolean): string => {
  return new Date(dateString).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12,
  });
};

export default function MemoryEditDialog({
  memory,
  open,
  onOpenChange,
  children,
  triggerRef,
}: MemoryEditDialogProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { data: memData } = useMemoriesQuery();
  const hour12 = useClockFormat();

  const hasUpdateAccess = useHasAccess({
    permissionType: PermissionTypes.MEMORIES,
    permission: Permissions.UPDATE,
  });
  /** A per-entry mirror of the adapter's own read-only guard (M3-WU-D2-2): the
   *  permission grants UPDATE in general, but this specific entry (e.g. the
   *  `conversational` layer, or a corpus-tier item) is not writable. Reachable
   *  only defensively — `MemoryCardActions` already withholds the trigger for
   *  a read-only entry — so the dialog still falls back to view-only rather
   *  than let a write reach the mutation and bounce off a 403. */
  const canEdit = hasUpdateAccess && memory?.readOnly !== true;

  const { mutate: updateMemory, isLoading } = useUpdateMemoryMutation({
    onSuccess: () => {
      showToast({
        message: localize('com_ui_saved'),
        status: 'success',
      });
      setApiError(null);
      onOpenChange(false);
      setTimeout(() => {
        triggerRef?.current?.focus();
      }, 0);
    },
    onError: (error: Error) => {
      const message = getMemoryApiErrorMessage(error, localize('com_ui_error'));
      /** Inline, not just a toast that can be missed — a write rejected by the
       *  adapter's read-only-layer guard (403, e.g. a TOCTOU race against a
       *  layer change) must never read as a silent success. */
      setApiError(message);
      showToast({ message, status: 'error' });
    },
  });

  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [originalKey, setOriginalKey] = useState('');
  const [touched, setTouched] = useState({ key: false, value: false });
  const [prevMemory, setPrevMemory] = useState<TUserMemory | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const memoryAddress = memory ? getMemoryAddress(memory) : null;
  const requiresKey =
    memoryAddress == null || !('id' in memoryAddress) || memory?.key.trim() !== '';

  if (memory !== prevMemory) {
    setPrevMemory(memory);
    if (memory) {
      setKey(memory.key);
      setValue(memory.value);
      setOriginalKey(memory.key);
      setTouched({ key: false, value: false });
      setApiError(null);
    }
  }

  const keyError =
    requiresKey || key.trim() !== ''
      ? getMemoryKeyError({
          key,
          memories: memData?.memories,
          agentId: memory?.agentId,
          originalKey,
        })
      : null;
  const valueError = getMemoryValueError(value);
  const hasErrors = keyError != null || valueError != null;
  /** Stay quiet on a pristine empty field; validate live once there is something to judge. */
  const showKeyError = canEdit && (touched.key || key !== '');
  const showValueError = canEdit && (touched.value || value !== '');

  const handleSave = () => {
    if (!canEdit || !memory || !memoryAddress) {
      return;
    }

    const trimmedKey = key.trim();
    if (keyError || valueError) {
      setTouched({ key: true, value: true });
      return;
    }

    const updateAddress = getMemoryUpdateAddress(memory, trimmedKey);
    if (!updateAddress) {
      return;
    }

    setApiError(null);
    updateMemory({
      ...updateAddress,
      value: value.trim(),
      agentId: memory.agentId,
    });
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.ctrlKey && canEdit) {
      handleSave();
    }
  };

  // Calculate memory-specific usage: available = tokenLimit - (totalTokens - thisMemoryTokens)
  const memoryUsage = useMemo(() => {
    if (!memory?.tokenCount || !memData?.tokenLimit) {
      return null;
    }
    const availableForMemory = memData.tokenLimit - (memData.totalTokens ?? 0) + memory.tokenCount;
    const percentage = Math.round((memory.tokenCount / availableForMemory) * 100);
    return { availableForMemory, percentage };
  }, [memory?.tokenCount, memData?.tokenLimit, memData?.totalTokens]);

  return (
    <OGDialog open={open} onOpenChange={onOpenChange} triggerRef={triggerRef}>
      {children}
      <OGDialogTemplate
        title={canEdit ? localize('com_ui_edit_memory') : localize('com_ui_view_memory')}
        showCloseButton={false}
        className="w-11/12 md:max-w-lg"
        main={
          <div className="space-y-4">
            {apiError != null && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-md border border-status-error-border bg-status-error-subtle p-3 text-sm text-text-destructive"
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>{apiError}</span>
              </div>
            )}
            {/* Memory metadata */}
            {memory && (
              <div className="flex items-center justify-between rounded-lg border border-border-light bg-surface-secondary px-3 py-2">
                {/* Token count - Left */}
                {memory.tokenCount !== undefined ? (
                  <span className="text-xs text-text-secondary">
                    {memory.tokenCount.toLocaleString()}{' '}
                    {localize(memory.tokenCount === 1 ? 'com_ui_token' : 'com_ui_tokens')}
                  </span>
                ) : (
                  <div />
                )}

                {/* Date - Center */}
                <span className="text-xs text-text-secondary">
                  {formatDateTime(memory.updated_at, hour12)}
                </span>

                {/* Usage badge - Right (memory-specific) */}
                {memoryUsage ? (
                  <MemoryUsageBadge
                    percentage={memoryUsage.percentage}
                    tokenLimit={memData?.tokenLimit ?? 0}
                    tooltipCurrent={memory.tokenCount}
                    tooltipMax={memoryUsage.availableForMemory}
                  />
                ) : (
                  <div />
                )}
              </div>
            )}

            {/* Key input */}
            <div className="space-y-2">
              <Label htmlFor="memory-key" className="text-sm font-medium text-text-primary">
                {localize('com_ui_key')}
              </Label>
              <Input
                id="memory-key"
                value={key}
                onChange={(e) => canEdit && setKey(e.target.value)}
                onBlur={() => setTouched((prev) => ({ ...prev, key: true }))}
                onKeyDown={handleKeyPress}
                placeholder={localize('com_ui_enter_key')}
                className="w-full"
                disabled={!canEdit}
                aria-invalid={showKeyError && keyError != null}
                aria-describedby="memory-key-message"
              />
              <FieldMessage
                id="memory-key-message"
                message={showKeyError && keyError ? localize(keyError) : null}
                hint={localize('com_ui_memory_key_hint')}
                lines={2}
              />
            </div>

            {/* Value textarea */}
            <div className="space-y-2">
              <Label htmlFor="memory-value" className="text-sm font-medium text-text-primary">
                {localize('com_ui_value')}
              </Label>
              <Textarea
                id="memory-value"
                value={value}
                onChange={(e) => canEdit && setValue(e.target.value)}
                onBlur={() => setTouched((prev) => ({ ...prev, value: true }))}
                onKeyDown={handleKeyPress}
                placeholder={localize('com_ui_enter_value')}
                className="min-h-[100px] w-full resize-none rounded-lg border border-border-light bg-transparent px-3 py-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-heavy disabled:cursor-not-allowed disabled:opacity-50"
                rows={4}
                disabled={!canEdit}
                aria-invalid={showValueError && valueError != null}
                aria-describedby="memory-value-message"
              />
              <FieldMessage
                id="memory-value-message"
                message={showValueError && valueError ? localize(valueError) : null}
              />
            </div>
          </div>
        }
        buttons={
          canEdit ? (
            <Button
              type="button"
              variant="submit"
              onClick={handleSave}
              aria-label={localize('com_ui_save')}
              disabled={isLoading || !memoryAddress || hasErrors}
            >
              {isLoading ? <Spinner className="size-4" /> : localize('com_ui_save')}
            </Button>
          ) : null
        }
      />
    </OGDialog>
  );
}
