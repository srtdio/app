// "Write to us": the support address in a copy box with the suggested line,
// and a mailto that opens the viewer's mail app with both filled in. Copy puts
// the address and the suggested line on the clipboard together. The caller
// passes the suggested line and mailto (request); without one it is the
// another-workspace ask.

import { Sheet } from '@/components/ui/Sheet';
import { Button, buttonClass } from '@/components/ui/Button';
import { useOptionalToast } from '@/components/ui/toast';
import { COPY_FAILED, copyText } from '@/lib/clipboard';
import {
  anotherWorkspaceBody,
  anotherWorkspaceRequest,
  SUPPORT_EMAIL,
  type ContactRequest,
} from '@/lib/support';

interface ContactSheetProps {
  open: boolean;
  onClose: () => void;
  workspaceName: string;
  request?: ContactRequest;
}

/** What Copy puts on the clipboard: the address, then the suggested line. */
export function contactClipboardText(
  workspaceName: string,
  body: string = anotherWorkspaceBody(workspaceName),
): string {
  return `${SUPPORT_EMAIL}\n${body}`;
}

export function ContactSheet({ open, onClose, workspaceName, request }: ContactSheetProps) {
  const toast = useOptionalToast();
  const ask = request ?? anotherWorkspaceRequest(workspaceName);
  async function copy(): Promise<void> {
    if (!(await copyText(contactClipboardText(workspaceName, ask.body)))) {
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
            href={ask.mailto}
            className={buttonClass(
              'primary',
              'default',
              'no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            )}
          >
            Open email
          </a>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-base leading-relaxed text-fg-2">
          Tell us what you need. Someone from the team replies by email.
        </p>
        <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-panel-2 py-1 pl-3 pr-1">
          <span className="min-w-0 flex-1 break-all text-base font-medium text-fg">
            {SUPPORT_EMAIL}
          </span>
          <Button className="shrink-0" onClick={() => void copy()}>
            Copy
          </Button>
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-sm text-fg-3">Suggested line, copied with the address:</p>
          <p className="text-base text-fg">{ask.body}</p>
        </div>
      </div>
    </Sheet>
  );
}
