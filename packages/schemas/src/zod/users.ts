import { z } from 'zod';

export const UserSchema = z.object({
  id: z.string().uuid(),
  display_name: z.string(),
  designation: z.string().nullable(),
  avatar_url: z.string().nullable(),
  deleted_at: z.string().nullable(),
  timezone: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  email_opt_in: z.boolean(),
  profile_completed_at: z.string().nullable(),
});

export type User = z.infer<typeof UserSchema>;
