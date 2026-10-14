// The Word viewer: the office Worker's escaped HTML, sanitized again with
// DOMPurify, shown ONLY inside an iframe with sandbox="" (no scripts, no same
// origin, no popups, forms or top navigation) whose srcdoc carries its own CSP
// (default-src 'none'; pictures from data:/blob: only). Nothing inside the
// file can run code, load from the network or open a link. Pages are white
// paper (the PDF viewer's paper token) on the viewer's stage in both themes.
// Loaded lazily by FileViewer, never in the main chunk.

import { useMemo } from 'react';
import type { ReactElement } from 'react';
import { DOC_SANDBOX, buildSrcdoc, sanitizeDocHtml } from '@/lib/files/office/sanitize';
import type { DocxView } from '@/lib/files/office/types';

/** The PDF page's paper colour (the --overlay-fg token), read from the app's theme. */
function paperToken(): string {
  if (typeof document === 'undefined') return '';
  return getComputedStyle(document.documentElement).getPropertyValue('--overlay-fg');
}

/** The iframe document for a parsed docx. */
export function wordSrcdoc(doc: DocxView, paper: string): string {
  return buildSrcdoc({ pages: doc.pages.map(sanitizeDocHtml), paper, margins: doc.margins });
}

export function WordViewer(props: { name: string; doc: DocxView }): ReactElement {
  const { doc } = props;
  // Unmounting (close) removes the frame and with it the document.
  const srcdoc = useMemo(() => wordSrcdoc(doc, paperToken()), [doc]);

  return (
    <iframe
      data-word-frame=""
      title={props.name}
      sandbox={DOC_SANDBOX}
      srcDoc={srcdoc}
      referrerPolicy="no-referrer"
      // Matches the srcdoc's light scheme so the frame stays transparent over the stage.
      style={{ colorScheme: 'light' }}
      className="absolute inset-0 h-full w-full border-0 bg-transparent"
    />
  );
}
