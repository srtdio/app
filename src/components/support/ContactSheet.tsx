// "Write to us": the support address in a copy box with the suggested line,
// and a mailto that opens the viewer's mail app with both filled in. Copy puts
// the address and the suggested line on the clipboard together. The caller
// passes the suggested line and mailto (request); without one it is the
// another-workspace ask.

import { useEffect, useRef, useState } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { Button, buttonClass } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { IconCheck, IconCopy, ICON_SIZE } from '@/components/ui/icons';
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

/** How long the tick shows after a copy. */
export const COPIED_MS = 2000;

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
  // After a copy the clipboard icon is a tick for COPIED_MS, as on a comment row.
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  async function copy(): Promise<void> {
    if (!(await copyText(contactClipboardText(workspaceName, ask.body)))) {
      toast?.show({ title: COPY_FAILED });
      return;
    }
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setCopied(false);
    }, COPIED_MS);
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
            className={buttonClass('primary', 'default', 'no-underline focus-visible:lit-focus')}
          >
            Open email
          </a>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-base text-fg-2">
          Tell us what you need. Someone from the team replies by email.
        </p>
        <div className="flex min-w-0 items-center gap-2 rounded-xl border bg-panel-2 lit-card-muted py-1 pl-3 pr-1">
          <span className="min-w-0 flex-1 break-all text-base font-medium text-fg">
            {SUPPORT_EMAIL}
          </span>
          <IconButton
            type="button"
            label="Copy email"
            data-contact-copy=""
            className="shrink-0"
            onClick={() => void copy()}
          >
            {copied ? <IconCheck size={ICON_SIZE.nav} /> : <IconCopy size={ICON_SIZE.nav} />}
          </IconButton>
          {copied ? (
            <span role="status" className="sr-only">
              Copied
            </span>
          ) : null}
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-sm text-fg-3">Suggested line, copied with the address:</p>
          <p className="text-base text-fg">{ask.body}</p>
        </div>
      </div>
    </Sheet>
  );
}
