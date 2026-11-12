import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AVATAR_CARD_PHONE_PX,
  AVATAR_CARD_SIZE,
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
  it('has exactly these roles: inline 20, message 36 (a message row on phone), header 32, row 40, card 48 (the list row picture from 768; 36 under it by classes), profile 72', () => {
    expect(AVATAR_PX).toEqual({
      inline: 20,
      stack: 32,
      message: 36,
      header: 32,
      row: 40,
      card: 48,
      profile: 72,
    });
    // Under 768 the card is the message photo's 36 (ROW_PICTURE_PHONE).
    expect(AVATAR_CARD_PHONE_PX).toBe(36);
    expect(AVATAR_CARD_PHONE_PX).toBe(AVATAR_PX.message);
  });

  it('the card role draws its initials at text-base from 768 and at the 36 message size (text-sm) under it, never text-lg', () => {
    const html = renderToStaticMarkup(createElement(Avatar, { role: 'card', name: 'Priya Shah' }));
    const classes = html.split(/[\s"]/);
    expect(classes).toContain('md:text-base');
    expect(classes).toContain('text-sm');
    expect(classes).not.toContain('text-base');
    expect(html).not.toContain('text-lg');
    // The phone initials are the 36 'message' photo's own size.
    const message = renderToStaticMarkup(
      createElement(Avatar, { role: 'message', name: 'Priya Shah' }),
    );
    expect(message.split(/[\s"]/)).toContain('text-sm');
  });

  it('renders each role at its size (inline style; card by its AVATAR_CARD_SIZE classes)', () => {
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

  it('card is 48 from 768 and 36 under it through classes (ROW_PICTURE, ROW_PICTURE_PHONE), no inline size', () => {
    expect(AVATAR_CARD_SIZE).toBe('h-9 w-9 md:h-12 md:w-12');
    for (const props of [
      { role: 'card' as const, name: 'Priya Shah' },
      { role: 'card' as const, name: 'Priya Shah', src: 'https://cdn/p.png' },
    ]) {
      const html = renderToStaticMarkup(createElement(Avatar, props));
      expect(html).toContain(AVATAR_CARD_SIZE);
      expect(html).not.toContain('style="width');
    }
    const row = renderToStaticMarkup(createElement(Avatar, { role: 'row', name: 'A B' }));
    expect(row).not.toContain('h-12');
    expect(row).not.toContain('h-9');
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
