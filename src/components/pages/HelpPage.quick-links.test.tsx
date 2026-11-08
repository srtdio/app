// Help quick links are flat chips (8 Nov 2026): the shared chip face (hairline
// border-strong, fg-2, no grey fill) inside the 44 NavLink tap box.
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { HelpPage } from '@/components/pages/HelpPage';
import { CHIP_FACE_SIZE, CHIP_HIT, CHIP_REST_EDGE } from '@/components/ui/Chip';

describe('Help quick links', () => {
  it('each link is the CHIP_HIT tap box around a flat chip face', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/help']}>
        <HelpPage />
      </MemoryRouter>,
    );
    const links = [...html.matchAll(/(<a [^>]*>)<span data-chip-face="" class="([^"]*)">([^<]*)</g)]
      .filter((m) => (m[1] ?? '').includes('data-help-quick-link=""'))
      .map((m) => ({
        hit: (/class="([^"]*)"/.exec(m[1] ?? '')?.[1] ?? '')
          .replace(/&amp;/g, '&')
          .replace(/&gt;/g, '>'),
        face: m[2] ?? '',
        label: m[3],
      }));
    expect(links.map((l) => l.label)).toEqual([
      'Pipeline',
      'Briefs',
      'Assets',
      'Chat with your team',
    ]);
    for (const { hit, face } of links) {
      expect(hit).toContain(CHIP_HIT);
      expect(face).toContain('rounded-full');
      expect(face).toContain('border');
      expect(face).toContain(CHIP_FACE_SIZE);
      expect(face).toContain(CHIP_REST_EDGE);
      for (const c of ['bg-panel-3', 'bg-panel-2', 'lit-well-soft']) {
        expect(face.split(' ')).not.toContain(c);
      }
    }
  });
});
