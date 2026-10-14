import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

// Static render only (node env, effects never run): stub every client the flow
// touches so importing it never builds a real Supabase client.
vi.mock('@/lib/supabase', () => ({ supabase: { auth: {}, from: vi.fn(), functions: {} } }));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({
    session: { user: { id: 'u-1', email: 'riya@kite.in', user_metadata: {} } },
  }),
}));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 'trace' }));

import { OnboardingFlow } from './OnboardingFlow';
import type { CurrentProfile } from '@/lib/use-current-profile';

const NEW_PROFILE: CurrentProfile = {
  display_name: 'riya',
  designation: null,
  avatar_url: null,
  email_opt_in: true,
  profile_completed_at: null,
  username: null,
};

function render(props: {
  profile: CurrentProfile;
  workspaceId: string | null;
  workspaceName: string | null;
}): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <OnboardingFlow {...props} onFinish={() => undefined} finishError={null} />
    </MemoryRouter>,
  );
}

describe('OnboardingFlow first screen', () => {
  it('opens a self sign-up on the name question with a six-step bar', () => {
    const out = render({ profile: NEW_PROFILE, workspaceId: null, workspaceName: null });
    expect(out).toContain('What should we call you?');
    expect(out).toContain('Step 1 of 6');
    expect(out).toContain('notifications, comments and chat');
  });

  it('opens an invitee on setting a password for their workspace', () => {
    const out = render({ profile: NEW_PROFILE, workspaceId: 'ws-1', workspaceName: 'Kite & Co' });
    expect(out).toContain('Join Kite &amp; Co');
    expect(out).toContain('Step 1 of 3');
    expect(out).toContain('riya@kite.in');
  });

  it('sends a finished profile with no workspace straight to naming one', () => {
    const done = { ...NEW_PROFILE, profile_completed_at: '2026-10-14T00:00:00Z' };
    const out = render({ profile: done, workspaceId: null, workspaceName: null });
    expect(out).toContain('Which brand are you starting with?');
    expect(out).toContain('Step 1 of 3');
  });
});
