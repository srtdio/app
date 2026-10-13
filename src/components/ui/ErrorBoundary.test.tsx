import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('@/lib/sentry', () => sentry);

import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import {
  ATTACHMENT_FALLBACK,
  AttachmentsFallback,
  MessageAttachments,
} from '@/components/chat/MessageAttachments';
import { PresignCache } from '@/lib/asset-presign';
import type { MessageAttachment } from '@/lib/chat/attachments';

// This repo renders React without a DOM in unit tests (no jsdom), where error
// boundaries cannot catch. The boundary is driven through its lifecycle here;
// the thread's own rows are each wrapped (checked below), and the browser path
// is exercised by e2e.

const cache = new PresignCache({
  endpoint: 'https://asset-read',
  getAccessToken: async () => 'tok',
  fetcher: async () => new Response('{}'),
});

const BROKEN: MessageAttachment = {
  assetId: 'v-broken',
  name: 'contract.pdf',
  mime: 'application/pdf',
};

describe('ErrorBoundary', () => {
  it('renders its children until one throws, then its fallback', () => {
    const boundary = new ErrorBoundary({
      name: 'chat-attachment',
      fallback: <p>fallback</p>,
      children: <p>child</p>,
    });
    expect(renderToStaticMarkup(boundary.render() as ReactElement)).toBe('<p>child</p>');
    boundary.state = ErrorBoundary.getDerivedStateFromError();
    expect(renderToStaticMarkup(boundary.render() as ReactElement)).toBe('<p>fallback</p>');
  });

  it('reports the crash to Sentry with the boundary name and context', () => {
    const boundary = new ErrorBoundary({
      name: 'file-viewer',
      fallback: null,
      children: null,
      context: { kind: 'pdf' },
    });
    const error = new Error('render failed');
    boundary.componentDidCatch(error, { componentStack: '\n at Page' });
    expect(sentry.captureException).toHaveBeenCalledWith(error, {
      boundary: 'file-viewer',
      component_stack: '\n at Page',
      kind: 'pdf',
    });
  });
});

describe('each message attachment area sits in its own boundary', () => {
  it('MessageAttachments wraps its body in a chat-attachment boundary', () => {
    const el = MessageAttachments({ attachments: [BROKEN], cache, presignEnabled: true });
    expect(isValidElement(el)).toBe(true);
    expect(el?.type).toBe(ErrorBoundary);
    const props = el?.props as { name: string; fallback: ReactElement };
    expect(props.name).toBe('chat-attachment');
    expect(props.fallback.type).toBe(AttachmentsFallback);
  });

  it('a throwing attachment shows the compact card: name, the line, Download', () => {
    const el = MessageAttachments({ attachments: [BROKEN], cache, presignEnabled: true });
    const props = el?.props as ConstructorParameters<typeof ErrorBoundary>[0];
    const boundary = new ErrorBoundary(props);
    boundary.state = ErrorBoundary.getDerivedStateFromError();
    const html = renderToStaticMarkup(boundary.render() as ReactElement);
    expect(html).toContain('data-attachments-fallback=""');
    expect(html).toContain('contract.pdf');
    expect(html).toContain(ATTACHMENT_FALLBACK.replace("'", '&#x27;'));
    expect(html).toContain('aria-label="Download contract.pdf"');
    expect(html).toContain('h-11 w-11');
  });

  it('every thread row has its own boundary, so one message never blanks the thread', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../chat/MessageThread.tsx', import.meta.url)),
      'utf8',
    );
    const boundary = src.indexOf('name="chat-message"');
    const row = src.indexOf('<MessageRow', boundary);
    expect(boundary).toBeGreaterThan(-1);
    expect(row).toBeGreaterThan(boundary);
    // The boundary closes right after the row, inside the per-message Fragment.
    expect(src.indexOf('</ErrorBoundary>', row)).toBeLessThan(src.indexOf('</Fragment>', row));
  });

  it('the viewer renders inside its own file-viewer boundary', () => {
    const src = readFileSync(fileURLToPath(new URL('./FileViewer.tsx', import.meta.url)), 'utf8');
    expect(src).toMatch(/<ErrorBoundary\s+name="file-viewer"/);
  });
});
