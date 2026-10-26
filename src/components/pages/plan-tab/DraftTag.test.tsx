import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { tagClass } from '@/components/ui/Tag';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/components/media/Thumbnail', () => ({ Thumbnail: () => null }));

import { DraftTag } from './PlanTabList';

// The Draft mark on a plan is the shared ui/Tag in the warn tone and keeps its
// data hook (the calendar and day menu find it by it).
describe('DraftTag', () => {
  it('renders the warn Tag with data-plan-tab-draft', () => {
    const html = renderToStaticMarkup(<DraftTag />);
    expect(html).toContain('data-plan-tab-draft=""');
    expect(html).toContain(tagClass('warn'));
    expect(html).toContain('Draft');
    expect(html).not.toContain('bg-warn-soft');
  });
});
