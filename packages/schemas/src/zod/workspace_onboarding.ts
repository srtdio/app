import { z } from 'zod';

export const WorkspaceOnboardingSchema = z.object({
  workspace_id: z.string().uuid(),
  first_post_at: z.string().nullable(),
  first_invite_at: z.string().nullable(),
  first_brief_at: z.string().nullable(),
  dismissed_at: z.string().nullable(),
  auto_hidden_at: z.string().nullable(),
});

export type WorkspaceOnboarding = z.infer<typeof WorkspaceOnboardingSchema>;
