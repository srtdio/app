// The one app-wide storage warning: rendered once by the workspace shell, above
// page content, for every member. Dismissed per person per device.

import { IconButton } from '@/components/ui/IconButton';
import { IconX } from '@/components/ui/icons';
import { storageWarningCopy } from './storage-usage';
import { useStorageWarning } from './useStorageWarning';

export function StorageWarningBanner() {
  const { usage, dismissed, dismiss } = useStorageWarning();
  if (usage === null || !usage.warn || dismissed) return null;
  return (
    <div className="shrink-0 px-4 pt-3 md:px-6">
      <div
        role="status"
        className="flex min-w-0 items-center gap-2 rounded-xl border border-warn bg-warn-soft py-1 pl-4 pr-1 text-legacy-sm text-fg"
      >
        <p className="min-w-0 flex-1 break-words py-2">{storageWarningCopy(usage.usedBytes)}</p>
        <IconButton label="Dismiss" onClick={dismiss} className="shrink-0">
          <IconX />
        </IconButton>
      </div>
    </div>
  );
}
