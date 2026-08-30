import React, { useState } from 'react';
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
import {
  getMemoryKeyError,
  getMemoryValueError,
  getMemoryApiErrorMessage,
  hasSovereignLayerData,
} from '~/utils/memory';
import { useCreateMemoryMutation, useMemoriesQuery } from '~/data-provider';
import { useLocalize, useHasAccess } from '~/hooks';

interface MemoryCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  triggerRef?: React.MutableRefObject<HTMLButtonElement | null>;
}

export default function MemoryCreateDialog({
  open,
  onOpenChange,
  children,
  triggerRef,
}: MemoryCreateDialogProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();

  const hasCreateAccess = useHasAccess({
    permissionType: PermissionTypes.MEMORIES,
    permission: Permissions.CREATE,
  });

  const { data: memData } = useMemoriesQuery();
  /** Only the sovereign backend (M3-WU-D2-2) projects `layer`; the default
   *  `mongo` backend never does, so this hint stays absent there. */
  const sovereignActive = hasSovereignLayerData(memData?.memories);

  const { mutate: createMemory, isLoading } = useCreateMemoryMutation({
    onSuccess: () => {
      showToast({
        message: localize('com_ui_memory_created'),
        status: 'success',
      });
      setApiError(null);
      onOpenChange(false);
      setKey('');
      setValue('');
      setTouched({ key: false, value: false });
      setTimeout(() => {
        triggerRef?.current?.focus();
      }, 0);
    },
    onError: (error: Error) => {
      const message = getMemoryApiErrorMessage(error, localize('com_ui_error'));
      /** Inline, not just a toast that can be missed — a write rejected by the
       *  adapter's read-only-layer guard (403) must never read as a silent
       *  success (M3-WU-D2-3 Part A, acceptance #1). */
      setApiError(message);
      showToast({ message, status: 'error' });
    },
  });

  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [touched, setTouched] = useState({ key: false, value: false });
  const [prevOpen, setPrevOpen] = useState(open);
  const [apiError, setApiError] = useState<string | null>(null);

  if (open !== prevOpen) {
    setPrevOpen(open);
    if (!open) {
      setKey('');
      setValue('');
      setTouched({ key: false, value: false });
      setApiError(null);
    }
  }

  const keyError = getMemoryKeyError({ key, memories: memData?.memories });
  const valueError = getMemoryValueError(value);
  const hasErrors = keyError != null || valueError != null;
  /** Stay quiet on a pristine empty field; validate live once there is something to judge. */
  const showKeyError = touched.key || key !== '';
  const showValueError = touched.value || value !== '';

  const handleSave = () => {
    if (!hasCreateAccess) {
      return;
    }

    if (keyError || valueError) {
      setTouched({ key: true, value: true });
      return;
    }

    setApiError(null);
    createMemory({
      key: key.trim(),
      value: value.trim(),
    });
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.ctrlKey && hasCreateAccess) {
      handleSave();
    }
  };

  return (
    <OGDialog open={open} onOpenChange={onOpenChange} triggerRef={triggerRef}>
      {children}
      <OGDialogTemplate
        title={localize('com_ui_create_memory')}
        showCloseButton={false}
        className="w-11/12 md:max-w-lg"
        main={
          <div className="space-y-4">
            {sovereignActive && (
              <p className="text-xs text-text-secondary">
                {localize('com_ui_memory_create_target_hint')}
              </p>
            )}
            {apiError != null && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-md border border-status-error-border bg-status-error-subtle p-3 text-sm text-text-destructive"
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>{apiError}</span>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="memory-key" className="text-sm font-medium text-text-primary">
                {localize('com_ui_key')}
              </Label>
              <Input
                id="memory-key"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                onBlur={() => setTouched((prev) => ({ ...prev, key: true }))}
                onKeyDown={handleKeyPress}
                placeholder={localize('com_ui_enter_key')}
                className="w-full"
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
            <div className="space-y-2">
              <Label htmlFor="memory-value" className="text-sm font-medium text-text-primary">
                {localize('com_ui_value')}
              </Label>
              <Textarea
                id="memory-value"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onBlur={() => setTouched((prev) => ({ ...prev, value: true }))}
                onKeyDown={handleKeyPress}
                placeholder={localize('com_ui_enter_value')}
                className="min-h-[100px] w-full resize-none rounded-lg border border-border-light bg-transparent px-3 py-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-heavy"
                rows={4}
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
          <Button
            type="button"
            variant="submit"
            onClick={handleSave}
            disabled={isLoading || hasErrors}
            aria-label={localize('com_ui_create_memory')}
          >
            {isLoading ? <Spinner className="size-4" /> : localize('com_ui_create')}
          </Button>
        }
      />
    </OGDialog>
  );
}
