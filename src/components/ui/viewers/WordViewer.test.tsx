// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WordViewer, wordSrcdoc } from '@/components/ui/viewers/WordViewer';
import { handleOfficeRequest } from '@/lib/files/office/handle';
import { PNG_1X1, docx, p } from '@/lib/files/office/test-fixtures';
import type { DocxView } from '@/lib/files/office/types';

function parsed(bytes: Uint8Array): DocxView {
  const res = handleOfficeRequest({
    op: 'view',
    bytes: bytes.slice().buffer as ArrayBuffer,
    mime: null,
  });
  if (!res.ok || res.op !== 'view' || res.result.kind !== 'docx') throw new Error('not docx');
  return res.result;
}

describe('WordViewer', () => {
  const doc = parsed(docx({ body: p('Diwali brief', 'Title') + p('Objective') }));

  it('renders only a sandbox="" iframe whose srcdoc carries the CSP', () => {
    const html = renderToStaticMarkup(<WordViewer name="brief.docx" doc={doc} />);
    expect(html).toMatch(/^<iframe /);
    expect(html).toContain('sandbox=""');
    expect(html).not.toMatch(/allow-(scripts|same-origin|popups|forms|top-navigation)/);
    expect(html.toLowerCase()).toContain('referrerpolicy="no-referrer"');
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain('Diwali brief');
  });

  it('a picture from the file stays inline; an external one never reaches the srcdoc', () => {
    const drawing = (id: string): string =>
      `<w:p><w:r><w:drawing><a:blip xmlns:a="y" r:embed="${id}"/></w:drawing></w:r></w:p>`;
    const withImages = parsed(
      docx({
        body: drawing('rIdIn') + drawing('rIdOut'),
        rels: [
          { id: 'rIdIn', type: 'image', target: 'media/a.png' },
          { id: 'rIdOut', type: 'image', target: 'https://tracker.example/p.png', external: true },
        ],
        files: { 'word/media/a.png': PNG_1X1 },
      }),
    );
    const srcdoc = wordSrcdoc(withImages, '#f4f5f6');
    expect(srcdoc).toMatch(/<img alt="" src="data:image\/png;base64,/);
    expect(srcdoc).not.toMatch(/https?:\/\//);
  });

  it('white paper from the paper token in both themes; fixed ink on it', () => {
    const srcdoc = wordSrcdoc(doc, '#f4f5f6');
    expect(srcdoc).toContain('.page{background:#f4f5f6;color:#1d1d24');
    expect(srcdoc).not.toContain('prefers-color-scheme');
  });
});
