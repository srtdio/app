import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: { auth: {} } }));

import { homeRouteFor } from './HomeGate';
import { CAPTIONS, FILM_LENGTH, SCENES, sceneAt } from './HomeFilm';

describe('homeRouteFor', () => {
  it('waits while the session resolves', () => {
    expect(homeRouteFor({ loading: true, signedIn: false })).toBe('loading');
  });
  it('sends signed-in users to the app', () => {
    expect(homeRouteFor({ loading: false, signedIn: true })).toBe('app');
  });
  it('shows the homepage to guests', () => {
    expect(homeRouteFor({ loading: false, signedIn: false })).toBe('home');
  });
});

describe('sceneAt', () => {
  it('maps every scene boundary to its scene', () => {
    SCENES.forEach(([start], i) => expect(sceneAt(start)).toBe(i));
  });
  it('is a pure function of time and wraps at the loop length', () => {
    expect(sceneAt(15)).toBe(sceneAt(15));
    expect(sceneAt(FILM_LENGTH + 7)).toBe(sceneAt(7));
    expect(sceneAt(FILM_LENGTH - 0.01)).toBe(4);
  });
  it('has one caption per scene and the ending has none', () => {
    expect(CAPTIONS).toHaveLength(SCENES.length);
    expect(CAPTIONS[4]).toEqual(['', '']);
  });
});
