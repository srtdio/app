// "This workspace is full": opened by any upload the asset-upload Worker refuses
// with 413 workspace_full (src/lib/storage-full.ts). Mounted once by the
// workspace shell. One sheet at a time: Contact us and Book a call replace it.

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BookCallSheet } from '@/components/support/BookCallSheet';
import { ContactSheet } from '@/components/support/ContactSheet';
import { SupportRows } from '@/components/support/SupportRows';
import { ActionRow } from '@/components/ui/ActionRow';
import { Button } from '@/components/ui/Button';
import { IconTrash } from '@/components/ui/icons';
import { Sheet } from '@/components/ui/Sheet';
import { humanizeSize } from '@/lib/assets';
import { useWorkspaceFullSheet } from '@/lib/storage-full';
import { useWorkspace } from '@/lib/workspace-context';

export const RECENTLY_DELETED_PATH = '/deleted';

/** The sheet's line for a refused file of this size. */
export function workspaceFullCopy(fileSizeBytes: number): string {
  return `There isn't room for this ${humanizeSize(fileSizeBytes)} file. Free up space in Recently deleted, or talk to us about more storage.`;
}

export function WorkspaceFullSheet() {
  const { fileSizeBytes, dismiss } = useWorkspaceFullSheet();
  const { workspaceId, workspaceDisplayName } = useWorkspace();
  const navigate = useNavigate();
  const [support, setSupport] = useState<'contact' | 'book' | null>(null);
  // Kept through the closing slide so the copy never flashes an empty size.
  const [shownBytes, setShownBytes] = useState(0);
  if (fileSizeBytes !== null && fileSizeBytes !== shownBytes) setShownBytes(fileSizeBytes);

  function openSupport(next: 'contact' | 'book'): void {
    dismiss();
    setSupport(next);
  }

  return (
    <>
      <Sheet
        open={fileSizeBytes !== null}
        onClose={dismiss}
        title="This workspace is full"
        footer={
          <Button variant="ghost" size="lg" className="ml-auto" onClick={dismiss}>
            Cancel
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm leading-relaxed text-fg-2">{workspaceFullCopy(shownBytes)}</p>
          <div className="-mx-3 flex flex-col">
            <ActionRow
              icon={<IconTrash size={18} />}
              label="Recently deleted"
              sub="Free up space now"
              onClick={() => {
                dismiss();
                navigate(RECENTLY_DELETED_PATH);
              }}
              chevron
            />
            <SupportRows
              onContact={() => openSupport('contact')}
              onBook={() => openSupport('book')}
            />
          </div>
        </div>
      </Sheet>
      <ContactSheet
        open={support === 'contact'}
        onClose={() => setSupport(null)}
        workspaceName={workspaceDisplayName ?? ''}
      />
      {workspaceId !== null ? (
        <BookCallSheet
          open={support === 'book'}
          onClose={() => setSupport(null)}
          workspaceId={workspaceId}
        />
      ) : null}
    </>
  );
}
