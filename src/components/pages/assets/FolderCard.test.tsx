import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { isValidElement } from 'react';
import { FolderCard } from '@/components/pages/assets/FolderCard';

describe('FolderCard', () => {
  it('renders the folder name and a pluralized item count', () => {
    const many = renderToStaticMarkup(<FolderCard name="Campaigns" count={3} onOpen={() => {}} />);
    expect(many).toContain('Campaigns');
    expect(many).toContain('3 items');

    const one = renderToStaticMarkup(<FolderCard name="Brand" count={1} onOpen={() => {}} />);
    expect(one).toContain('1 item');
    expect(one).not.toContain('1 items');
  });

  it('fires onOpen when the card is tapped', () => {
    const onOpen = vi.fn();
    // FolderCard is hook-free, so calling it returns the root <button> element
    // whose onClick is wired straight to onOpen.
    const element = FolderCard({ name: 'Brand', count: 0, onOpen });
    expect(isValidElement(element)).toBe(true);
    if (!isValidElement(element)) return;
    const onClick = (element.props as { onClick: () => void }).onClick;
    onClick();
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
