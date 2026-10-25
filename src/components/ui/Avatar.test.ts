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
  it('has exactly four sizes: inline 20, header 32, row 40, profile 72', () => {
    expect(AVATAR_PX).toEqual({ inline: 20, header: 32, row: 40, profile: 72 });
  });

  it('renders each role at its size', () => {
    for (const role of Object.keys(AVATAR_PX) as AvatarRole[]) {
      const html = renderToStaticMarkup(createElement(Avatar, { role, name: 'Priya Shah' }));
      const px = AVATAR_PX[role];
      expect(html).toContain(`width:${px}px`);
      expect(html).toContain(`height:${px}px`);
      expect(html).toContain(`data-avatar-role="${role}"`);
    }
  });
});

describe('Avatar shapes', () => {
  it('draws people as circles at every role', () => {
    for (const role of Object.keys(AVATAR_PX) as AvatarRole[]) {
      expect(avatarShapeClass(role)).toBe('rounded-full');
      expect(avatarShapeClass(role, 'person')).toBe('rounded-full');
    }
  });

  it('draws groups and notes as rounded squares: lg at 40 and below, xl at 72', () => {
    for (const kind of ['group', 'note'] as const) {
      expect(avatarShapeClass('inline', kind)).toBe('rounded-lg');
      expect(avatarShapeClass('header', kind)).toBe('rounded-lg');
      expect(avatarShapeClass('row', kind)).toBe('rounded-lg');
      expect(avatarShapeClass('profile', kind)).toBe('rounded-xl');
    }
  });

  it('applies the shape to the rendered face', () => {
    const person = renderToStaticMarkup(createElement(Avatar, { role: 'row', name: 'A B' }));
    expect(person).toContain('rounded-full');
    const group = renderToStaticMarkup(
      createElement(Avatar, { role: 'profile', kind: 'group', name: 'Team' }),
    );
    expect(group).toContain('rounded-xl');
    expect(group).not.toContain('rounded-full');
  });
});
