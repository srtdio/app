import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AVATAR_PX,
  Avatar,
  avatarFillFor,
  avatarShapeClass,
  initialsFor,
  type AvatarRole,
} from '@/components/ui/Avatar';

describe('avatarFillFor', () => {
  it('maps a name to one of the six avatar tokens, deterministically', () => {
    const fill = avatarFillFor('Priya Shah');
    expect(fill).toMatch(/^bg-avatar-[1-6]$/);
    expect(avatarFillFor('Priya Shah')).toBe(fill);
  });

  it('covers every token across names and never returns a hex', () => {
    const seen = new Set<string>();
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) seen.add(avatarFillFor(name));
    expect(seen.size).toBe(6);
    for (const fill of seen) expect(fill).not.toMatch(/#/);
  });
});

describe('initialsFor', () => {
  it('takes the first and last word', () => {
    expect(initialsFor('Priya Anand Shah')).toBe('PS');
    expect(initialsFor('  priya  ')).toBe('P');
  });
});

describe('Avatar roles', () => {
  it('has exactly five roles: inline 20, header 32, row 40, card 48 (the list row picture; 40 in Compact), profile 72', () => {
    expect(AVATAR_PX).toEqual({
      inline: 20,
      stack: 32,
      header: 32,
      row: 40,
      card: 48,
      profile: 72,
    });
  });

  it('the card role draws its initials at text-base (the row size), never text-lg', () => {
    const html = renderToStaticMarkup(createElement(Avatar, { role: 'card', name: 'Priya Shah' }));
    expect(html).toContain('text-base');
    expect(html).not.toContain('text-lg');
  });

  it('renders each role at its size (inline style; card by its h-12 w-12 classes)', () => {
    for (const role of Object.keys(AVATAR_PX) as AvatarRole[]) {
      const html = renderToStaticMarkup(createElement(Avatar, { role, name: 'Priya Shah' }));
      const px = AVATAR_PX[role];
      expect(html).toContain(`data-avatar-role="${role}"`);
      if (role === 'card') {
        expect(html).not.toContain('width:');
        continue;
      }
      expect(html).toContain(`width:${px}px`);
      expect(html).toContain(`height:${px}px`);
    }
  });

  it('card is 48 through classes (h-12 w-12, ROW_PICTURE), no inline size', () => {
    for (const props of [
      { role: 'card' as const, name: 'Priya Shah' },
      { role: 'card' as const, name: 'Priya Shah', src: 'https://cdn/p.png' },
    ]) {
      const html = renderToStaticMarkup(createElement(Avatar, props));
      expect(html).toContain('h-12 w-12');
      expect(html).not.toContain('style="width');
    }
    const row = renderToStaticMarkup(createElement(Avatar, { role: 'row', name: 'A B' }));
    expect(row).not.toContain('h-12 w-12');
  });
});

describe('Avatar shapes', () => {
  // L2 (8 Nov 2026): people take the group shape at every size.
  it('draws every kind as a rounded square: lg at 48 and below, xl at 72', () => {
    expect(avatarShapeClass('card')).toBe('rounded-lg');
    expect(avatarShapeClass('inline')).toBe('rounded-lg');
    expect(avatarShapeClass('header')).toBe('rounded-lg');
    expect(avatarShapeClass('row')).toBe('rounded-lg');
    expect(avatarShapeClass('profile')).toBe('rounded-xl');
  });

  it('never draws a person round', () => {
    for (const role of Object.keys(AVATAR_PX) as AvatarRole[]) {
      const face = renderToStaticMarkup(createElement(Avatar, { role, name: 'A B' }));
      expect(face).not.toContain('rounded-full');
      const img = renderToStaticMarkup(
        createElement(Avatar, { role, name: 'A B', src: 'https://x/a.png' }),
      );
      expect(img).not.toContain('rounded-full');
    }
  });

  it('applies the shape to the rendered face', () => {
    const person = renderToStaticMarkup(createElement(Avatar, { role: 'row', name: 'A B' }));
    expect(person).toContain('rounded-lg');
    expect(person).not.toContain('rounded-full');
    const group = renderToStaticMarkup(
      createElement(Avatar, { role: 'profile', kind: 'group', name: 'Team' }),
    );
    expect(group).toContain('rounded-xl');
    expect(group).not.toContain('rounded-full');
  });
});
