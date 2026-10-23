import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ON_BEHALF_FIELD,
  ON_BEHALF_TITLE,
  OnBehalfApproveView,
  approverLabel,
  toApproverOptions,
  type OnBehalfApproveViewProps,
} from '@/components/ui/OnBehalfApproveSheet';

describe('approverLabel', () => {
  it('reads "Name (Brand)"', () => {
    expect(approverLabel('Kiran Shah', 'Zomato')).toBe('Kiran Shah (Zomato)');
  });
  it('drops the brand when unknown', () => {
    expect(approverLabel('Kiran Shah', null)).toBe('Kiran Shah');
  });
});

describe('toApproverOptions', () => {
  it('keeps active client members with a name, in order', () => {
    const names = new Map([
      ['u1', 'Kiran'],
      ['u2', 'Asha'],
      ['u3', 'Ravi'],
    ]);
    expect(
      toApproverOptions(
        [
          { user_id: 'u1', role: 'client', active: true },
          { user_id: 'u2', role: 'agency', active: true },
          { user_id: 'u3', role: 'client', active: false },
        ],
        names,
      ),
    ).toEqual([{ userId: 'u1', name: 'Kiran' }]);
  });
});

describe('OnBehalfApproveView', () => {
  function props(over: Partial<OnBehalfApproveViewProps> = {}): OnBehalfApproveViewProps {
    return {
      open: true,
      approvers: [
        { userId: 'u1', name: 'Kiran Shah' },
        { userId: 'u2', name: 'Asha Rao' },
      ],
      brand: 'Zomato',
      selected: 'u1',
      onSelect: vi.fn(),
      busy: false,
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
      ...over,
    };
  }

  it('confirms with the picked approver id', () => {
    const p = props();
    const tree = OnBehalfApproveView(p);
    const footer = (
      tree.props as { footer: { props: { children: Array<{ props: { onClick: () => void } }> } } }
    ).footer;
    footer.props.children[1]!.props.onClick();
    expect(p.onConfirm).toHaveBeenCalledWith('u1');
  });

  it('has the sheet title and field label and never the post title', () => {
    const tree = OnBehalfApproveView(props());
    expect((tree.props as { title: string }).title).toBe(ON_BEHALF_TITLE);
    const html = renderToStaticMarkup(
      (tree.props as { children: Parameters<typeof renderToStaticMarkup>[0] }).children,
    );
    expect(html).toContain(ON_BEHALF_FIELD);
    expect(html).toContain('Kiran Shah (Zomato)');
    expect(html).not.toContain('Launch teaser');
  });
});
