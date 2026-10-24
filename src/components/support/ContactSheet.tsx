// "Write to us": the support address in a copy box with the suggested line,
// and a mailto that opens the viewer's mail app with both filled in. Copy puts
// the address and the suggested line on the clipboard together.

import { Sheet } from '@/components/ui/Sheet';
import { Button } from '@/components/ui/Button';
import { useOptionalToast } from '@/components/ui/toast';
import { COPY_FAILED, copyText } from '@/lib/clipboard';
import { anotherWorkspaceBody, anotherWorkspaceMailto, SUPPORT_EMAIL } from '@/lib/support';

export interface ContactSheetProps {
  open: boolean;
  onClose: () => void;
  workspaceName: string;
}

/** What Copy puts on the clipboard: the address, then the suggested line. */
export function contactClipboardText(workspaceName: string): string {
  return `${SUPPORT_EMAIL}\n${anotherWorkspaceBody(workspaceName)}`;
}

export function ContactSheet({ open, onClose, workspaceName }: ContactSheetProps) {
  const toast = useOptionalToast();
  async function copy(): Promise<void> {
    if (!(await copyText(contactClipboardText(workspaceName)))) {
      toast?.show({ title: COPY_FAILED });
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Write to us"
      footer={
        <>
          <Button variant="ghost" className="ml-auto" onClick={onClose}>
            Close
          </Button>
          <a
            href={anotherWorkspaceMailto(workspaceName)}
            className="inline-flex h-11 items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-accent-fg no-underline transition-colors hover:bg-accent-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Open email
          </a>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm leading-relaxed text-fg-2">
          Tell us what you need. Someone from the team replies by email.
        </p>
        <div className="flex min-w-0 items-center gap-2 rounded-[10px] border border-border bg-panel-2 py-1 pl-3 pr-1">
          <span className="min-w-0 flex-1 break-all text-sm font-medium text-fg">
            {SUPPORT_EMAIL}
          </span>
          <Button className="shrink-0" onClick={() => void copy()}>
            Copy
          </Button>
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-[11px] text-fg-3">Suggested line, copied with the address:</p>
          <p className="text-sm text-fg">{anotherWorkspaceBody(workspaceName)}</p>
        </div>
      </div>
    </Sheet>
  );
}
