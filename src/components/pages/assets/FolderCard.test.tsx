import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FolderCard } from '@/components/pages/assets/FolderCard';

// The card wires long-press through useLongPress(longPressHandler, tapHandler).
// There is no DOM in this (node) test environment, so the hook is mocked to a
// spy that records its two callbacks; invoking them asserts that a tap opens and
// a long-press routes to onManage (or to onOpen when onManage is absent). With
// the hook mocked the component is hook-free again, so it also renders to markup.
const useLongPress = vi.hoisted(() => vi.fn(() => ({})));
vi.mock('@/components/pages/assets/useLongPress', () => ({ useLongPress }));

function lastCallbacks(): { longPress: () => void; tap: () => void } {
  const call = useLongPress.mock.calls.at(-1) as unknown as [() => void, () => void];
  return { longPress: call[0], tap: call[1] };
}

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
    renderToStaticMarkup(<FolderCard name="Brand" count={0} onOpen={onOpen} />);
    lastCallbacks().tap();
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('routes a long-press to onManage when manage rights are present', () => {
    const onOpen = vi.fn();
    const onManage = vi.fn();
    renderToStaticMarkup(<FolderCard name="Brand" count={0} onOpen={onOpen} onManage={onManage} />);
    lastCallbacks().longPress();
    expect(onManage).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('treats a long-press as a plain open when onManage is omitted', () => {
    const onOpen = vi.fn();
    renderToStaticMarkup(<FolderCard name="Brand" count={0} onOpen={onOpen} />);
    lastCallbacks().longPress();
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
